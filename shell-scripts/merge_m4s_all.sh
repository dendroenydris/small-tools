#!/bin/bash

# Find pairs of files where the first 8 characters of the filenames are the same
sudo find ./video -type f -exec basename {} \; | awk '{count[substr($0,1,8)]++} END{for(i in count) if(count[i]>1) print i}' | while read -r prefix
do
    audio_file=$(find ./video -name "${prefix}*" -type f -exec du -a {} + | sort -n | head -n 1 | cut -f 2)
    video_file=$(find ./video -name "${prefix}*" -type f -exec du -a {} + | sort -n | tail -n 1 | cut -f 2)

    # Check if the audio file is smaller in size
    audio_size=$(du -b "$audio_file" | cut -f 1)
    video_size=$(du -b "$video_file" | cut -f 1)

    if [ "$audio_size" -lt "$video_size" ]; then
	ffmpeg -i "$audio_file" -i "$video_file" -c:v copy -c:a aac -strict experimental ${video_file}.mp4
    else
        ffmpeg -i "$video_file" -i "$audio_file" -c:v copy -c:a aac -strict experimental ${video_file}.mp4
    fi
done