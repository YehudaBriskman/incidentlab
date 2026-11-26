# IncidentLab lab base image (#147): the tools a player needs to investigate a case from a real shell.
# Case images (lab/case.Dockerfile) add only the public evidence at /case. No answers, no solvers, no
# project files are ever copied here: the build context of this image is this directory alone.
#
# Alpine keeps the image small (a class pulls it over one school connection), with the GNU userland
# (coreutils, grep, sed, findutils, gawk) so toolbox commands and solvers behave exactly as on Debian/WSL.
# Built in CI (.github/workflows/lab.yml). Published to GHCR under the incidentslab organisation once it
# exists (#144, #151); pin the base by digest when publishing.
FROM alpine:3.20

RUN apk add --no-cache \
      bash coreutils grep sed findutils gawk diffutils util-linux-misc \
      tcpdump bind-tools jq less vim git unzip file procps tzdata ca-certificates

# A non-root analyst. The evidence is read-only for the case; players work in /home/analyst.
RUN adduser -D -s /bin/bash analyst
USER analyst
WORKDIR /case
ENV LANG=C.UTF-8 TZ=UTC
LABEL org.opencontainers.image.title="IncidentLab lab base" \
      org.opencontainers.image.description="Tools for investigating IncidentLab cases: tcpdump, dig, jq, gawk, git" \
      org.opencontainers.image.licenses="MIT"
CMD ["bash", "-l"]
