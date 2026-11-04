import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "./advisor-message.css";

const schema = { ...defaultSchema, tagNames: ["p", "strong", "em", "u", "ul", "ol", "li", "br", "blockquote", "a", "h1", "h2", "h3", "h4", "pre", "code", "hr", "del", "table", "thead", "tbody", "tr", "th", "td"] };

export const AdvisorMessage = memo(function AdvisorMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Provider control tags never belong in a message, even when split across
  // transport chunks. Formatting is rendered through a strict HTML allowlist.
  let content = text.replace(/\[(?:stance|tag|reply-to):[^\]]*(?:\]|$)/gi, "");
  if (streaming) content = content.replace(/\[(?:st(?:ance)?|ta(?:g)?|reply(?:-to)?)?:?[^\]]*$/i, "");
  if (streaming) {
    content = content.replace(/<(?:\/?[a-z][^>]*|\/?)$/i, "").replace(/\[([^\]]+)\]\([^)]*$/, "$1");
    // While a closing delimiter is still on the wire, show its text plainly.
    // Complete emphasis is left for the Markdown renderer; list markers stay.
    for (const marker of ["**", "__", "*"]) {
      const positions: number[] = [];
      for (let index = content.indexOf(marker); index >= 0; index = content.indexOf(marker, index + marker.length)) {
        if (content[index - 1] === "\\") continue;
        if (marker === "*" && (content[index - 1] === "*" || content[index + 1] === "*")) continue;
        if (marker === "*" && /(^|\n)\s*$/.test(content.slice(0, index)) && /^\s/.test(content.slice(index + 1))) continue;
        positions.push(index);
      }
      if (positions.length % 2) { const index = positions[positions.length - 1]; content = content.slice(0, index) + content.slice(index + marker.length); }
    }
  }
  return <div className="advisor-message"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
    components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{content}</Markdown></div>;
});
