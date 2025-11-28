FROM texlive/texlive:latest-full

# Enable contrib repository and install Microsoft core fonts
RUN sed -i 's/main$/main contrib/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's/main$/main contrib/' /etc/apt/sources.list && \
    apt-get update && \
    echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        fontconfig \
        fonts-liberation \
        ttf-mscorefonts-installer && \
    fc-cache -f -v && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
