#!/bin/bash

# Check if the "merged" folder exists, if not, create it
mkdir -p merged

# Iterate through mp4 files in the current directory
for video_file in *.mp4; do
    # Extract file name without extension
    file_name=$(basename "$video_file" .mp4)
    
    # Check if a corresponding mp3 file exists
    audio_file="${file_name}.mp3"
    if [ -e "$audio_file" ]; then
        # Merge video and audio for mp4
	ffmpeg -i "$video_file" -i "$audio_file" -c:v copy -c:a aac -strict experimental -map 0:v:0 -map 1:a:0 "merged/${file_name}.mp4"
    fi

    # Check if a corresponding webm file exists
    audio_file="${file_name}.webm"
    if [ -e "$audio_file" ]; then
        # Convert webm to mp3
        ffmpeg -i "$audio_file" -vn -c:a libmp3lame "merged/${file_name}.mp3"
        # Merge video and audio for webm
        ffmpeg -i "$video_file" -i "merged/${file_name}.mp3" -c:v copy -c:a aac -strict experimental "merged/${file_name}.mp4"
    fi
done
