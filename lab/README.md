# Lab images (lab mode, #146)

A lab image is a Linux shell with the investigation tools and one case's **public** evidence at `/case`.
It is the optional "real terminal" track next to the browser Explorer. Answers are still checked on the site.

- `lab/base/Dockerfile`: the tools (tcpdump, dig, jq, gawk, git, less, vim), running as a non-root `analyst`.
- `lab/case.Dockerfile`: the base plus `/case`, read-only.
- `scripts/build-lab-image.sh <case-id>`: builds both from a clean context and proves the result:
  - `scripts/lab_gate.py` checks that `/case` equals the public evidence zip file by file, and that no file
    looks like a secret artefact;
  - the case solver runs inside the image, with the solver and answer key mounted read-only for that check
    only.
- Toolbox items may carry a lab variant (`syntaxLab` free, `lab` paid, #149), shown under the toolbox's Lab tab
  and run from `/case`. `LAB_IMAGE_CHECK=1 scripts/check_commands.py <case-id> --lab-only` runs each one in the
  image with `docker run --rm --network none`.
- CI (`.github/workflows/lab.yml`) builds and proves every case's image on pull requests that touch the lab,
  generators or solvers. Nothing is pushed from this repo. Publishing to GHCR under the `incidentslab`
  organisation is #151.

Never add anything to an image that is not in the public evidence zip (see `docs/DATA.md`, "Never publish").
