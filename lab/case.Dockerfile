# One case's lab image (#148): the base tools plus that case's public evidence at /case, read-only.
# scripts/build-lab-image.sh builds it from a clean temporary context that holds ONLY this file and the
# extracted public evidence zip, then scripts/lab_gate.py proves /case equals the zip file by file.
ARG BASE=incidentlab/lab-base:local
FROM ${BASE}
ARG CASE_ID
ARG CASE_VERSION=1
USER root
COPY case/ /case/
RUN chown -R root:root /case && chmod -R a+rX,a-w /case
USER analyst
WORKDIR /case
LABEL org.opencontainers.image.title="IncidentLab lab: ${CASE_ID}" \
      io.incidentlab.case="${CASE_ID}" \
      io.incidentlab.case-version="${CASE_VERSION}"
