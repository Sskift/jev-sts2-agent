import sys
import time
import math
import ctypes
from PIL import ImageGrab

user32 = ctypes.windll.user32

# DPI Awareness to ensure exact pixel matching
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000

def get_screen_resolution():
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    return w, h

def set_mouse_pos(x, y):
    user32.SetCursorPos(int(x), int(y))

def click(x, y, delay=0.1):
    set_mouse_pos(x, y)
    time.sleep(delay)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(delay)

def drag_and_drop(start_x, start_y, end_x, end_y, duration=0.35, steps=25):
    """
    Smoothly drags mouse from (start_x, start_y) to (end_x, end_y).
    Crucial for Slay the Spire 2 card targeting animations.
    """
    set_mouse_pos(start_x, start_y)
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)

    step_delay = duration / max(steps, 1)
    for i in range(1, steps + 1):
        t = i / steps
        # Smooth ease-in-out curve
        ease_t = 0.5 * (1 - math.cos(math.pi * t))
        curr_x = start_x + (end_x - start_x) * ease_t
        curr_y = start_y + (end_y - start_y) * ease_t
        set_mouse_pos(curr_x, curr_y)
        time.sleep(step_delay)

    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.1)

def capture_screen(output_path="temp/screen.png"):
    img = ImageGrab.grab()
    img.save(output_path)
    return img.size

if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "capture":
            path = sys.argv[2] if len(sys.argv) > 2 else "temp/screen.png"
            size = capture_screen(path)
            print(f"Captured {size[0]}x{size[1]} to {path}")
        elif cmd == "click":
            x, y = int(sys.argv[2]), int(sys.argv[3])
            click(x, y)
            print(f"Clicked ({x}, {y})")
        elif cmd == "drag":
            sx, sy = int(sys.argv[2]), int(sys.argv[3])
            ex, ey = int(sys.argv[4]), int(sys.argv[5])
            drag_and_drop(sx, sy, ex, ey)
            print(f"Dragged ({sx}, {sy}) -> ({ex}, {ey})")
        elif cmd == "resolution":
            w, h = get_screen_resolution()
            print(f"{w}x{h}")
    else:
        w, h = get_screen_resolution()
        print(f"Computer Use Ready. Screen: {w}x{h}")

