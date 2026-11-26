# IncidentLab lab base image (#147): the tools a player needs to investigate a case from a real shell.
# Case images (lab/case.Dockerfile) add only the public evidence at /case. No answers, no solvers, no
# project files are ever copied here: the build context of this image is this directory alone.
#
# Built in CI (.github/workflows/lab.yml) for linux/amd64 and linux/arm64. Published to GHCR under the
# incidentslab organisation once it exists (#144, #151). Pin the base by digest when publishing.
FROM debian:bookworm-slim

# tcpdump/tshark-free pcap reading, DNS tools, JSON, POSIX text tools, a pager and an editor, git for the
# repo-history cases, unzip for evidence packs. --no-install-recommends keeps the image small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tcpdump dnsutils jq gawk less vim-tiny git unzip file bsdextrautils procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# A non-root analyst. The evidence is read-only for the case; players work in /home/analyst.
RUN useradd --create-home --shell /bin/bash analyst
USER analyst
WORKDIR /case
ENV LANG=C.UTF-8 TZ=UTC
LABEL org.opencontainers.image.title="IncidentLab lab base" \
      org.opencontainers.image.description="Tools for investigating IncidentLab cases: tcpdump, dig, jq, gawk, git" \
      org.opencontainers.image.licenses="MIT"
CMD ["bash", "-l"]
