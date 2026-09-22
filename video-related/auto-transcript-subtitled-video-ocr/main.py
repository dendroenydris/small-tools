import sys
import cv2
import numpy as np
import glob
from moviepy.editor import VideoFileClip
import os
from tqdm import tqdm
from datetime import timedelta
import srt
from skimage.metrics import structural_similarity as ssim
import easyocr


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


def get_frame(idx, video_clip):
    return video_clip.get_frame(idx / video_clip.fps)


def detect_similarity(frame1, frame2, scale=512):
    # Resize frames
    new_height = int((frame1.shape[1] / frame1.shape[0]) * scale)
    frame1_resized = (
        cv2.resize(frame1, (scale, new_height)) if scale < frame1.shape[1] else frame1
    )
    frame2_resized = (
        cv2.resize(frame2, (scale, new_height)) if scale < frame1.shape[1] else frame2
    )

    # Convert frames to grayscale
    gray1 = cv2.cvtColor(frame1_resized, cv2.COLOR_RGB2GRAY)
    gray2 = cv2.cvtColor(frame2_resized, cv2.COLOR_RGB2GRAY)

    return ssim(gray1, gray2)


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


def easyocr(frame):
    reader = easyocr.Reader(
        ["ch_sim"]
    )  # this needs to run only once to load the model into memory
    result = reader.readtext(image=frame)
    text = [t for _, t, _ in result]
    return " ".join(text)


from cnocr import CnOcr


def cnocr(frame):
    ocr = CnOcr()
    out = ocr.ocr_for_single_line(frame)
    print(out)
    return out

from rapidocr_onnxruntime import RapidOCR
def rocr(frame):
    engine = RapidOCR()
    result, elapse = engine(frame)
    text=""
    if(result!=None):
        text = [t for _, t, _ in result]
    return " ".join(text)



def generate_srt_from(video_clip, clips):
    subs = []

    idx = 0
    progress_bar = tqdm(total=len(clips) - 1, desc="Processing ocr", unit="subtitles")
    for i in range(len(clips) - 1):
        frame = get_frame(clips[i + 1] - 1, video_clip)
        text = rocr(frame)
        if(text!=""):
            subs.append(
                srt.Subtitle(
                    index=idx,
                    start=timedelta(milliseconds=int(clips[i] / video_clip.fps * 1000)),
                    end=timedelta(milliseconds=int(clips[i + 1] / video_clip.fps * 1000)),
                    content=text,
                )
            )
        idx += 1
        progress_bar.update(1)
    return subs


def save_subs(filename, subs):
    with open(filename, "w") as f:
        f.write(srt.compose(subs))


def generate_clip_list(
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
        if sim_direct < sim_threshold:
            print(frame_indices[idx] - clip_list[-1])
            if ini_step != 1:
                idx_temp, sim = argmin_frame_between(
                    frame_indices[idx],
                    frame_indices[idx + 1],
                    ini_step // 2,
                    video_clip,
                )
            else:
                idx_temp = idx
            clip_list += [idx_temp]
            print(sim_direct, idx_temp)
        progress_bar.update(1)

    clip_list.append(-1)
    print(clip_list)
    return clip_list


def transcript_video_file(
    video_clip,
    output_path,
    step=8,
    sim_threshold=0.7,
    min_step=3,
    sim_scale=128,
):
    clip_list = generate_clip_list(
        video_clip,
        sim_threshold=sim_threshold,
        ini_step=step,
        min_step=min_step,
        sim_scale=sim_scale,
    )
    subs = generate_srt_from(video_clip, clips=clip_list)
    print(subs)
    save_subs(output_path + ".srt", subs)
    
def process_video_clip(output_dir, videofilename,sim=0.5,step=16):
    video_clip = VideoFileClip(videofilename)
    # video_clip = video_clip.subclip(0, 10)
    video_name = os.path.basename(videofilename)
    output_video_path = os.path.join(output_dir, os.path.splitext(video_name)[0])
    transcript_video_file(
        video_clip, output_video_path, sim_threshold=sim, step=step, sim_scale=512
    )
    print(f"Successfully processed {video_name}")
    
if __name__ == "__main__":
    output_dir = "output"
    sim = 0.3;step=8
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
    ensure_directory_exists(output_dir)
    print(f"sim={sim};step={step}")
    if len(sys.argv) > 1:
        pre_entered_input = sys.argv[1]
        process_video_clip(output_dir=output_dir,videofilename=pre_entered_input,sim=sim,step=step)
    else:
        videos = [f for f in glob.glob("video/*") if is_valid_video_file(f)]
        for video in videos:
            process_video_clip(output_dir=output_dir,videofilename=video,sim=sim)
