// Shared strict multipart delimiter scanner for voice QA.
// Legal delimiter lines only: start-of-body `--boundary`, or CRLF followed
// by `--boundary`, each followed by CRLF (part) or a COMPLETE closing suffix
// `--` + optional SP/TAB + (CRLF | end-of-body). A prefix such as
// CRLF `--boundary--NOT-A-DELIMITER` is payload, never a delimiter.
export function findDelimiters(buf, boundary) {
  const marker = Buffer.from("--" + boundary);
  const delims = [];
  let from = 0;
  for (;;) {
    const i = buf.indexOf(marker, from);
    if (i < 0) break;
    const atStart = i === 0;
    const afterCrlf = i >= 2 && buf[i - 2] === 13 && buf[i - 1] === 10;
    const t = i + marker.length;
    const b0 = t < buf.length ? buf[t] : -1;
    const b1 = t + 1 < buf.length ? buf[t + 1] : -1;
    const isClose = b0 === 45 && b1 === 45;
    const isCrlf = b0 === 13 && b1 === 10;
    let valid = false;
    if (atStart || afterCrlf) {
      if (isCrlf) {
        valid = true;
      } else if (isClose) {
        let j = t + 2;
        while (j < buf.length && (buf[j] === 32 || buf[j] === 9)) j++;
        if (j >= buf.length) valid = true;
        else if (buf[j] === 13 && j + 1 < buf.length && buf[j + 1] === 10) valid = true;
      }
    }
    if (valid) delims.push({ at: i, close: isClose, head: t + 2 });
    from = i + 1;
  }
  return delims;
}

export function splitParts(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType || "");
  if (!m) return null;
  const boundary = (m[1] || m[2] || "").trim();
  if (!boundary) return null;
  const delims = findDelimiters(buf, boundary);
  const parts = [];
  for (let d = 0; d < delims.length; d++) {
    if (delims[d].close) break;
    const next = delims[d + 1];
    if (!next) break;
    const bodyStart = delims[d].head;
    let bodyEnd = next.at - 2;
    if (bodyEnd < bodyStart) bodyEnd = bodyStart;
    const s = buf.subarray(bodyStart, bodyEnd);
    const sep = s.indexOf(Buffer.from("\r\n\r\n"));
    if (sep < 0) continue;
    const head = s.subarray(0, sep).toString("latin1");
    const body = s.subarray(sep + 4);
    const m1 = /name\s*=\s*"?([^";\r\n]+)"?/.exec(head);
    const m2 = /filename\s*=\s*"?([^";\r\n]+)"?/.exec(head);
    parts.push({ name: m1 ? m1[1].trim() : "", filename: m2 ? m2[1].trim() : "", headers: head, body });
  }
  return { boundary, parts };
}