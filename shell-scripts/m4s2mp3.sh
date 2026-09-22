#!/bin/bash
for file in *.m4s; do
    ffmpeg -i "$file" -c:a libmp3lame -q:a 4 "${file%.m4s}.mp3"
done