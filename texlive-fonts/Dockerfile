FROM texlive/texlive:latest-full

# Install Microsoft core fonts and other common fonts
RUN apt-get update && \
    echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        fontconfig \
        fonts-liberation \
        ttf-mscorefonts-installer && \
    fc-cache -f -v && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
