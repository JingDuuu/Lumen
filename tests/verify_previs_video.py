"""Decode the retained real editor export without the UI or generation engine."""
import json
from pathlib import Path

import av
import numpy as np


def main():
    root = Path(__file__).resolve().parents[1]
    path = root / 'diagnostics/previs4-export.mp4'
    frames = 0
    first = last = None
    timestamps = []
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        fps = float(stream.average_rate)
        duration = float(stream.duration * stream.time_base)
        width, height = stream.width, stream.height
        for frame in container.decode(stream):
            image = frame.to_ndarray(format='rgb24')
            if first is None:
                first = image
            last = image
            timestamps.append(float(frame.pts * frame.time_base))
            frames += 1
    difference = float(np.abs(first.astype(float) - last.astype(float)).mean())
    assert (width, height) == (960, 540)
    assert frames == 48 and fps == 24 and duration == 2
    assert all(abs(time - index / 24) < 1e-6 for index, time in enumerate(timestamps))
    assert difference > 0.2, difference
    evidence = dict(file=path.name, frames=frames, fps=fps, duration=duration,
                    width=width, height=height, mean_first_last_difference=difference,
                    timestamps=timestamps)
    (root / 'diagnostics/previs4-media-evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in evidence.items() if key != 'timestamps'}))


if __name__ == '__main__':
    main()
