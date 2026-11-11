#!/bin/sh
# Builds main.pdf and page previews (png/) with the TeX Live Docker image.
cd "$(dirname "$0")"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/w" -w /w texlive/texlive:latest-medium sh -c \
 "for i in 1 2 3; do pdflatex -interaction=nonstopmode main.tex >/dev/null; done
  grep -nE '^!|Warning|Overfull|Output written|undefined' main.log | grep -v 'Font shape' | head -30
  mkdir -p png; gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r70 -sOutputFile=png/p%02d.png main.pdf"
