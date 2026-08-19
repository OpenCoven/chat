# The image CI runs in.
#
# It exists to take `apt-get` off the critical path. Six separate CI runs hung
# on an apt-get that never returned -- once in the Tauri dependency install,
# five times in Playwright's `install --with-deps` -- each holding a runner
# until a timeout or GitHub's six-hour ceiling killed it. Nothing about those
# failures involved this repository's code, and re-running was the only remedy.
#
# Installing the same packages here does not make apt more reliable. It moves
# the unreliability somewhere it cannot block a pull request: this image is
# built on its own schedule, and a build that hangs is a red mark on one
# workflow rather than a wedged merge queue. CI jobs then pull a finished image.
#
# The base already carries Playwright's browsers and their system libraries at
# the exact version this repository pins, so the browser download disappears
# along with the apt call. Bumping @playwright/test therefore means bumping the
# tag below in the same commit -- they are one version, expressed twice.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Links the published package to this repository, which is what lets a CI job's
# GITHUB_TOKEN pull it and what makes the package page point back at the
# Dockerfile that produced it. A CI image with no stated provenance is a
# binary blob that everything depends on and nothing explains.
LABEL org.opencontainers.image.source=https://github.com/OpenCoven/chat
LABEL org.opencontainers.image.description="Build and test environment for OpenCoven Chat CI."

# apt must never wait for input on a machine with no one to answer.
ENV DEBIAN_FRONTEND=noninteractive

# Tauri's Linux build needs the GTK and WebKit development headers; the rest
# are what actions/checkout and actions/cache expect to find on PATH, which a
# container does not get for free the way a hosted runner does.
#
# Deliberately no --no-install-recommends: this list is a transcription of what
# the workflow installed before, and dropping recommended packages would be a
# behavioural change smuggled in under a reliability fix.
RUN apt-get update \
  && apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    file \
    git \
    libayatana-appindicator3-dev \
    libgtk-3-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libxdo-dev \
    librsvg2-dev \
    patchelf \
    pkg-config \
    unzip \
    wget \
    xdg-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*

# Fail the build rather than ship an image that is quietly missing a library
# and would surface as a confusing linker error inside a CI job instead.
RUN pkg-config --exists webkit2gtk-4.1 \
  && pkg-config --exists gtk+-3.0 \
  && test -d /ms-playwright
