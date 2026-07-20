#!/bin/bash

#===============================================================================
# INSTALL ESSENTIAL LATEX PACKAGES
#===============================================================================
# Installs commonly used LaTeX packages for academic writing
#===============================================================================

echo "Installing system fonts..."
apt-get update

# Pre-accept Microsoft fonts EULA
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections

# Install fonts
DEBIAN_FRONTEND=noninteractive apt-get install -y fontconfig fonts-liberation ttf-mscorefonts-installer

# Rebuild font cache
fc-cache -f -v

echo "Installing essential LaTeX packages..."

tlmgr install \
    amsmath amsfonts amsthm amssymb \
    setspace caption xcolor geometry algorithm2e \
    graphicx float tikz appendix lipsum footmisc \
    natbib hyperref cleveref enumitem url \
    kpfonts ulem lettrine titlesec makecell multirow \
    relsize mathtools gensymb cuted comment psfrag pbox mathdots cancel pdflscape \
    booktabs longtable tabularx array \
    subcaption wrapfig \
    biblatex biber \
    listings minted fancyvrb \
    tcolorbox \
    siunitx \
    ifoddpage changepage adjustbox collectbox \
    fancyhdr lastpage \
    pgfplots pgfplotstable \
    csquotes babel-italian babel-english \
    microtype ragged2e everysel \
    soul \
    todonotes

tlmgr path add

echo ""
echo "Essential LaTeX packages installed successfully!"
