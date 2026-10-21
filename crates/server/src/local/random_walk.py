# Mean squared displacement of a random walk on a square lattice.
# Standard library only. A fixed seed gives the same output every time.
import random

random.seed(1)
MOVES = [(1, 0), (-1, 0), (0, 1), (0, -1)]
WALKERS = 1000

print("steps   mean R^2   R^2 / steps")
for steps in (10, 100, 1000):
    total = 0
    for _ in range(WALKERS):
        x = y = 0
        for _ in range(steps):
            dx, dy = random.choice(MOVES)
            x += dx
            y += dy
        total += x * x + y * y
    msd = total / WALKERS
    print(f"{steps:5d}   {msd:8.1f}   {msd / steps:11.3f}")
