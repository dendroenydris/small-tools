import sys
import cv2
import numpy as np
import glob
from moviepy.editor import VideoFileClip
import os
from tqdm import tqdm
from skimage.metrics import structural_similarity as ssim


def ensure_directory_exists(directory):
    if not os.path.exists(directory):
        try:
            os.makedirs(directory)
            print(f"Created directory: {directory}")
        except OSError as error:
            print(f"Error creating directory {directory}: {error}")
            raise


def is_valid_video_file(file):
    try:
        with VideoFileClip(file) as video_clip:
            return True
    except Exception as e:
        print(f"Invalid video file: {file}, Error: {e}")
        return False


def detect_similarity(frame1, frame2, scale=64):
    # Resize frames to 64x64
    frame1_resized = cv2.resize(frame1, (scale, scale))
    frame2_resized = cv2.resize(frame2, (scale, scale))

    # Convert frames to grayscale
    gray1 = cv2.cvtColor(frame1_resized, cv2.COLOR_RGB2GRAY)
    gray2 = cv2.cvtColor(frame2_resized, cv2.COLOR_RGB2GRAY)

    return ssim(gray1, gray2)


def generate_clup_list_manual(
    video_clip, step=1, sim_threshold=0.7, min_step=3, sim_scale=128
):
    total_frames = int(video_clip.fps * video_clip.duration)
    frame_indices = [i for i in range(0, total_frames, step)]
    clip_list = [0]

    for idx in range(0, len(frame_indices) - step, step):
        frame1 = video_clip.get_frame(frame_indices[idx] / video_clip.fps)
        frame2 = video_clip.get_frame(frame_indices[idx + 1] / video_clip.fps)
        if (detect_similarity(frame1, frame2, scale=sim_scale) < sim_threshold) and (
            frame_indices[idx] - clip_list[-1] > step * min_step
        ):
            clip_list.append(idx)
    clip_list.append(-1)
    return clip_list


def get_frame(idx, video_clip):
    return video_clip.get_frame(idx / video_clip.fps)


def argmin_frame_between(begin, end, step, video_clip):
    L = []
    for i in range(begin, end, step):
        frame1 = get_frame(i, video_clip)
        frame2 = get_frame(i + step, video_clip)
        L.append(detect_similarity(frame1, frame2))
    position = max(begin, begin + step * max(0, np.array(L).argmin() - 1))
    if step == 1:
        return position + 1, np.array(L).min()
    return argmin_frame_between(
        max(begin, position - step * 2),
        min(end, position + step * 2),
        step // 2,
        video_clip,
    )


def generate_clup_list_auto(
    video_clip, sim_threshold=0.5, min_step=2, ini_step=4, sim_scale=128
):
    total_frames = int(video_clip.fps * video_clip.duration)
    frame_indices = [i for i in range(0, total_frames, ini_step)]
    clip_list = [0]
    progress_bar = tqdm(
        total=total_frames // ini_step, desc="Processing frames", unit="frames"
    )
    for idx in range(0, len(frame_indices) - 1):
        frame1 = get_frame(frame_indices[idx], video_clip)
        frame2 = get_frame(frame_indices[idx + 1], video_clip)
        sim_direct = detect_similarity(frame1, frame2, scale=sim_scale)
        if (sim_direct < sim_threshold) and (
            frame_indices[idx] - clip_list[-1] > ini_step * min_step
        ):
            print(frame_indices[idx] - clip_list[-1])
            idx, sim = argmin_frame_between(
                frame_indices[idx], frame_indices[idx +
                                                  1], ini_step // 2, video_clip
            )
            clip_list += [idx]
            print(sim_direct, idx)
        progress_bar.update(1)

    clip_list.append(-1)
    print(clip_list)
    return clip_list


def clip_video_file(
    video_clip,
    output_path,
    option="auto",
    step=1,
    sim_threshold=0.7,
    min_step=3,
    sim_scale=128,
):
    # total_frames = int(video_clip.fps * video_clip.duration)
    if option != "auto":
        clip_list = generate_clup_list_manual(
            video_clip, step, sim_threshold, min_step, sim_scale=sim_scale
        )
    else:
        clip_list = generate_clup_list_auto(
            video_clip,
            sim_threshold=sim_threshold,
            ini_step=step,
            min_step=min_step,
            sim_scale=sim_scale,
        )

    if len(clip_list) == 2:
        return

    progress_bar = tqdm(total=len(clip_list) - 1,
                        desc="Processing clips", unit="clips")
    print(clip_list)

    for i in range(0, len(clip_list) - 1):
        clip = video_clip.subclip(
            clip_list[i] / video_clip.fps,
            clip_list[i + 1] / video_clip.fps,
        )
        clip.write_videofile(
            f"{output_path}-{i}.mp4", codec="libx264", audio_codec="aac"
        )
        progress_bar.update(1)


def process_video_clip(
    output_dir, videofilename, sim_threshold=0.3, step=64, sim_scale=256, min_step=3
):
    video_clip = VideoFileClip(videofilename)
    # video_clip = video_clip.subclip(0, 2000 / video_clip.fps)
    video_name = os.path.basename(videofilename)
    this_out_dir = output_dir + "/" + video_name.split(".")[0]
    ensure_directory_exists(this_out_dir)
    output_video_path = os.path.join(
        this_out_dir, os.path.splitext(video_name)[0])
    clip_video_file(
        video_clip,
        output_video_path,
        sim_threshold=sim_threshold,
        min_step=min_step,
        step=step,
        sim_scale=sim_scale,
    )
    print(f"Successfully processed {video_name}")


if __name__ == "__main__":
    output_dir = "output"
    ensure_directory_exists(output_dir)
    print(sys.argv)
    sim = 0.3
    step = 64
    if "--sim" in sys.argv:
        index = sys.argv.index("--sim")
        # Check if there is a value after '--sim' in sys.argv
        if index + 1 < len(sys.argv):
            # Assign the next item as simvalue
            try:
                sim = float(sys.argv[index + 1])
            except:
                print("sim value error")
    if "--step" in sys.argv:
        index = sys.argv.index("--step")
        # Check if there is a value after '--sim' in sys.argv
        if index + 1 < len(sys.argv):
            # Assign the next item as simvalue
            try:
                step = int(sys.argv[index + 1])
            except:
                print("step value error")

    if "-i" in sys.argv:
        index = sys.argv.index("-i")
        if index + 1 < len(sys.argv):
            # Assign the next item as simvalue
            pre_entered_input = sys.argv[index + 1]
            process_video_clip(
                output_dir="./",
                videofilename=pre_entered_input,
                sim_threshold=sim, step=step
            )
        else:
            print("no input file")
    else:
        videos = [f for f in glob.glob("video/*") if is_valid_video_file(f)]
        for video in videos:
            process_video_clip(
                output_dir=output_dir, videofilename=video, sim_threshold=sim, step=step
            )
