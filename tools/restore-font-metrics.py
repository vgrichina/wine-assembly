#!/usr/bin/env python3
"""Copy a font's hhea and OS/2 tables onto a subset of it.

    python3 tools/restore-font-metrics.py <source.ttf> <subset.ttf>

Subsetting recomputes the font-wide metric summaries over the glyphs that
survived. Drop the widest glyph and advanceWidthMax moves, taking
tmMaxCharWidth with it; drop enough glyphs and OS/2.xAvgCharWidth moves too,
taking tmAveCharWidth. Windows reported the values the full font declared, so a
guest that sizes a column from tmMaxCharWidth would lay out differently against
the deployed subset than against the vendored font it was cut from - a
difference that appears only in the deployed build.

Every field is copied except hhea.numberOfHMetrics, which has to keep
describing the subset's own hmtx table rather than the source's.

Used by tools/gen-font-subsets.sh. test/test-font-subsets.js checks the result
through the emulator's own TrueType parser.
"""

import sys

from fontTools.ttLib import TTFont

RESTORE = ('hhea', 'OS/2')


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    source, target = argv[1], argv[2]
    src_font = TTFont(source)
    # recalcTimestamp defaults to True, which stamps head.modified with the
    # current time on save and makes every regeneration produce different
    # bytes - so `gen-font-subsets.sh --check` could never pass and the
    # committed subsets could never be shown to match their generator.
    dst_font = TTFont(target, recalcTimestamp=False)

    for tag in RESTORE:
        if tag not in src_font or tag not in dst_font:
            continue
        src_table = src_font[tag]
        dst_table = dst_font[tag]
        keep = dst_table.numberOfHMetrics if tag == 'hhea' else None
        for name, value in vars(src_table).items():
            if name.startswith('_'):
                continue
            setattr(dst_table, name, value)
        if keep is not None:
            dst_table.numberOfHMetrics = keep

    dst_font.save(target)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
