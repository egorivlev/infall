# Estimate pi by sampling points in the unit square.
# Standard library only. A fixed seed gives the same output every time.
import math
import random

random.seed(7)
inside = 0
for n in range(1, 200_001):
    x, y = random.random(), random.random()
    if x * x + y * y <= 1.0:
        inside += 1
    if n in (1_000, 10_000, 100_000, 200_000):
        estimate = 4 * inside / n
        print(f"{n:7d} points: pi is about {estimate:.4f} (off by {abs(estimate - math.pi):.4f})")
