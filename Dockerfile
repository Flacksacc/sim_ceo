# Build web client
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Build API (no external packages: offline-safe restore)
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS apibuild
WORKDIR /src
COPY server/ ./
RUN dotnet restore SimCEO.Api/SimCEO.Api.csproj
RUN dotnet publish SimCEO.Api/SimCEO.Api.csproj -c Release -o /app/publish --no-restore

# Runtime: serve API + static web from wwwroot
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=apibuild /app/publish ./
COPY --from=webbuild /web/dist ./wwwroot
ENV ASPNETCORE_URLS=http://+:5080
EXPOSE 5080
# Portable HTTP health probe: exactly one of curl/wget must exist for the
# container HEALTHCHECK below (the base image ships neither). Debian/Ubuntu
# (apt-get), Azure Linux (tdnf) and Alpine (apk) are covered; the build
# FAILS if no probe can be provided, so an always-unhealthy image can never
# ship silently.
RUN set -e; \
    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo "health probe already present"; \
    elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*; \
    elif command -v tdnf >/dev/null 2>&1; then tdnf install -y curl && tdnf clean all; \
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl; \
    else echo "no supported package manager and no curl/wget" >&2; exit 1; fi; \
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD curl -fsS http://localhost:5080/health || wget -qO- http://localhost:5080/health
ENTRYPOINT ["dotnet", "SimCEO.Api.dll"]
