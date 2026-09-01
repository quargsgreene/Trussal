"""
Manuscript figure style — shared by every figNN_*.py.

Design follows the `dataviz` skill: form-by-job, the validated CVD-safe
categorical order, ONE y-axis per axes, sequential (one-hue, darker = more
impaired) for the network-profile dimension, reserved status colours for
pass/fail overlays only, thin marks, recessive grid, a legend for >=2 series
with selective direct labels.

Deviation from that skill's default: SERIF text (to sit beside LaTeX body
type) and no interactive/hover layer — these are static print figures. Set
LOADTEST_FIG_FONT=sans to use a sans stack instead.

Usage:
    from plotstyle import (apply_style, new_figure, save_figure,
                           CATEGORICAL_COLORS, PROFILE_RAMP_COLORS, STATUS_COLORS)

    apply_style("single")                     # or "1p5" / "double"
    figure, axes = new_figure("single", width_to_height_ratio=1.6)
    ...
    save_figure(figure, "fig01_bandwidth_vs_participants")
"""

from __future__ import annotations

import os
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt

FIGURE_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "figures_out"

# IEEE single column 3.487"; Elsevier single 3.54". 3.487 is the safe minimum.
COLUMN_WIDTH_INCHES = {"single": 3.487, "1p5": 5.0, "double": 7.16}

# --- palette (from dataviz/references/palette.md, light surface) --------------
CATEGORICAL_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
                      "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
# One-hue blue ramp, light -> dark; assigned so a WORSE network profile is darker.
PROFILE_RAMP_COLORS = ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
STATUS_COLORS = {"good": "#0ca30c", "warning": "#fab219",
                 "serious": "#ec835a", "critical": "#d03b3b"}

PRIMARY_INK = "#0b0b0b"
SECONDARY_INK = "#52514e"
MUTED_INK = "#898781"
GRIDLINE_COLOR = "#e1e0d9"
AXIS_COLOR = "#c3c2b7"
PAGE_SURFACE_COLOR = "#ffffff"   # a manuscript page is white

_SERIF_FONT_STACK = ["STIX Two Text", "Nimbus Roman", "Times New Roman", "DejaVu Serif"]
_SANS_FONT_STACK = ["Helvetica", "Arial", "TeX Gyre Heros", "DejaVu Sans"]

# Back-compat aliases (earlier figure code used these names).
CATEGORICAL = CATEGORICAL_COLORS
PROFILE_RAMP = PROFILE_RAMP_COLORS
STATUS = STATUS_COLORS


def apply_style(column: str = "single") -> None:
    use_sans_serif = os.environ.get("LOADTEST_FIG_FONT", "serif").lower() == "sans"
    mpl.rcParams.update({
        "figure.facecolor": PAGE_SURFACE_COLOR,
        "axes.facecolor": PAGE_SURFACE_COLOR,
        "savefig.facecolor": PAGE_SURFACE_COLOR,
        "font.family": "sans-serif" if use_sans_serif else "serif",
        "font.serif": _SERIF_FONT_STACK,
        "font.sans-serif": _SANS_FONT_STACK,
        "mathtext.fontset": "dejavusans" if use_sans_serif else "stix",
        "font.size": 8,
        "axes.titlesize": 8,
        "axes.labelsize": 8,
        "xtick.labelsize": 7,
        "ytick.labelsize": 7,
        "legend.fontsize": 6.8,
        "axes.linewidth": 0.6,
        "axes.edgecolor": AXIS_COLOR,
        "axes.labelcolor": PRIMARY_INK,
        "axes.titlecolor": PRIMARY_INK,
        "text.color": PRIMARY_INK,
        "xtick.color": MUTED_INK,
        "ytick.color": MUTED_INK,
        "xtick.labelcolor": SECONDARY_INK,
        "ytick.labelcolor": SECONDARY_INK,
        "xtick.major.width": 0.6,
        "ytick.major.width": 0.6,
        "xtick.major.size": 2.5,
        "ytick.major.size": 2.5,
        "axes.grid": True,
        "axes.grid.axis": "both",
        "grid.color": GRIDLINE_COLOR,
        "grid.linewidth": 0.4,
        "grid.alpha": 0.9,
        "axes.axisbelow": True,
        "lines.linewidth": 0.9,
        "lines.markersize": 3.5,
        "lines.markeredgewidth": 0.0,
        "legend.frameon": False,
        "legend.handlelength": 1.6,
        "legend.borderpad": 0.2,
        "legend.columnspacing": 1.0,
        "legend.handletextpad": 0.5,
        "figure.dpi": 150,
        "savefig.dpi": 400,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.02,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "figure.constrained_layout.use": True,
        "axes.prop_cycle": mpl.cycler(color=CATEGORICAL_COLORS),
    })


def new_figure(column: str = "single", width_to_height_ratio: float = 1.618,
               height_inches: float | None = None, n_columns: int = 1, n_rows: int = 1,
               **subplots_kwargs):
    figure_width = COLUMN_WIDTH_INCHES.get(column, COLUMN_WIDTH_INCHES["single"])
    figure_height = height_inches if height_inches is not None else figure_width / width_to_height_ratio
    figure, axes = plt.subplots(n_rows, n_columns, figsize=(figure_width, figure_height),
                                **subplots_kwargs)
    for one_axes in (axes.flat if hasattr(axes, "flat") else [axes]):
        one_axes.spines["top"].set_visible(False)
        one_axes.spines["right"].set_visible(False)
    return figure, axes


def profile_color(profile_index: int, profile_count: int) -> str:
    """Pick a blue-ramp step for the profile-th of `profile_count` WWAN profiles."""
    if profile_count <= 1:
        return PROFILE_RAMP_COLORS[len(PROFILE_RAMP_COLORS) // 2]
    ramp_index = round(profile_index / (profile_count - 1) * (len(PROFILE_RAMP_COLORS) - 1))
    return PROFILE_RAMP_COLORS[ramp_index]


def direct_label(axes, x, y, text, color, x_offset_pt=2, y_offset_pt=0, **annotate_kwargs):
    """Selective direct label at the end of a line (dataviz: <=4 series)."""
    axes.annotate(text, xy=(x, y), xytext=(x_offset_pt, y_offset_pt),
                  textcoords="offset points", color=color, fontsize=6.6, va="center",
                  clip_on=False, **annotate_kwargs)


def watermark(figure, text: str = "synthetic") -> None:
    """Tiny figure-level tag (bottom-left), clear of any axes content."""
    figure.text(0.004, 0.004, text, fontsize=5.5, color="#c2c1ba",
                ha="left", va="bottom")


def save_figure(figure, output_name: str, output_dir: Path | str | None = None) -> Path:
    output_dir = Path(output_dir or FIGURE_OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = output_dir / f"{output_name}.pdf"
    png_path = output_dir / f"{output_name}.png"
    figure.savefig(pdf_path)
    figure.savefig(png_path)
    plt.close(figure)
    print(f"  wrote {pdf_path.relative_to(output_dir.parent)}  +  {png_path.name}")
    return pdf_path


# Back-compat aliases.
new_fig = new_figure
save = save_figure
