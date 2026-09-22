#!/bin/bash

# Check if the "mp3" folder exists, if not, create it
mkdir -p mp3

# Convert webm files to mp3
for file in *.webm; do
    ffmpeg -i "$file" -vn -acodec libmp3lame "mp3/$(basename "$file" .webm).mp3"
done