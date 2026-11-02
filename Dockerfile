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
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://localhost:5080/health || exit 1
ENTRYPOINT ["dotnet", "SimCEO.Api.dll"]
