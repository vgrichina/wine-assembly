#include <windows.h>

/*
 * Native Windows 98 font metric reference.
 *
 * Metric compatibility is the whole point of the Tier 1 substitutions, so it
 * has to be measured against the real thing rather than asserted from Red
 * Hat's design intent. This walks a fixed ladder of requested heights for a
 * fixed set of faces and emits, over COM1, exactly the numbers an application
 * can observe: the TEXTMETRIC, every advance width in 0x20..0x7E, and
 * GetTextExtentPoint32 for strings real dialogs lay out.
 *
 * The output is line-oriented on purpose — one record per line, fields
 * separated by spaces — so tools/v86-reference/font-metrics-to-json.js can
 * pin it as a reference without a parser worth debugging.
 *
 *   FACE <name>
 *   TM <request> <height> <ascent> <descent> <internalLeading> <externalLeading>
 *      <aveCharWidth> <maxCharWidth> <weight> <overhang> <italic> <underlined>
 *      <struckOut> <firstChar> <lastChar> <defaultChar> <breakChar>
 *      <pitchAndFamily> <charSet>
 *   CW <request> <width for 0x20> ... <width for 0x7E>
 *   EX <request> <cx> <cy> <string index>
 *   END
 */

unsigned long _tls_index = 0;

static HANDLE serial;

static const char *const faces[] = {
  "Arial", "Times New Roman", "Courier New", "Tahoma",
  "MS Sans Serif", "System", "Fixedsys", "Small Fonts",
};

/* Requested lfHeight values. Negative asks for character height as GDI defines
 * it; 8 through 20 is where hinting decides pixel widths, and the larger
 * negatives catch a scaling error that small sizes round away.
 *
 * Positive values ask for total cell height instead, and they are here because
 * that is the case we cannot answer from the negative ladder. A raster face
 * owns a fixed set of strikes, so the interesting question is what GDI does
 * with a request that falls between two of them: return the neighbouring
 * strike at its native size, or resample it to the number that was asked for.
 * The negative sweep only ever reported native strike heights, which is
 * suggestive but not decisive, since a positive request names a cell height
 * directly and could plausibly be honoured literally.
 *
 * The sizes past -32 exist for the other end of the ladder. Once a request
 * exceeds the largest strike a face ships there is nothing left to select, so
 * whatever GDI does there is synthesis rather than selection, and single-strike
 * faces like Fixedsys and System reach it early. */
static const int heights[] = {
  -8, -9, -10, -11, -12, -13, -14, -16, -18, -20, -24, -32,
  -40, -48, -64, -80,
  8, 10, 12, 13, 15, 16, 19, 20, 24, 30, 32, 40,
};

/* Strings a real Win98 dialog lays out, plus two that exercise the widest and
 * narrowest glyphs in the ASCII range. */
static const char *const strings[] = {
  "OK",
  "Cancel",
  "The quick brown fox jumps over the lazy dog.",
  "iiiiiiiiii",
  "WWWWWWWWWW",
  "For Help, click Help Topics on the Help Menu.",
};

static void emit_n(const char *text, DWORD count) {
  DWORD written;
  if (serial != INVALID_HANDLE_VALUE) WriteFile(serial, text, count, &written, NULL);
}

static void emit(const char *text) {
  emit_n(text, (DWORD)lstrlenA(text));
}

static void emit_int(int value) {
  char digits[16];
  int length = 0;
  unsigned int magnitude;
  if (value < 0) {
    emit("-");
    magnitude = (unsigned int)(-value);
  } else {
    magnitude = (unsigned int)value;
  }
  do {
    digits[length++] = (char)('0' + magnitude % 10);
    magnitude /= 10;
  } while (magnitude);
  while (length) emit_n(&digits[--length], 1);
}

static void emit_field(int value) {
  emit(" ");
  emit_int(value);
}

static void emit_face(HDC dc, const char *face) {
  int height_index;
  int index;

  emit("FACE ");
  emit(face);
  emit("\r\n");

  for (height_index = 0;
       height_index < (int)(sizeof(heights) / sizeof(heights[0]));
       height_index++) {
    int request = heights[height_index];
    HFONT font = CreateFontA(request, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
      ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY,
      DEFAULT_PITCH | FF_DONTCARE, face);
    HFONT old;
    TEXTMETRICA metrics;
    char actual[LF_FACESIZE];
    int widths[95];

    if (!font) continue;
    old = (HFONT)SelectObject(dc, font);
    GetTextMetricsA(dc, &metrics);
    GetTextFaceA(dc, LF_FACESIZE, actual);

    /* A face GDI did not honour would silently report some other font's
     * metrics, which is worse than reporting nothing. Name what answered. */
    emit("ACTUAL");
    emit_field(request);
    emit(" ");
    emit(actual);
    emit("\r\n");

    emit("TM");
    emit_field(request);
    emit_field(metrics.tmHeight);
    emit_field(metrics.tmAscent);
    emit_field(metrics.tmDescent);
    emit_field(metrics.tmInternalLeading);
    emit_field(metrics.tmExternalLeading);
    emit_field(metrics.tmAveCharWidth);
    emit_field(metrics.tmMaxCharWidth);
    emit_field(metrics.tmWeight);
    emit_field(metrics.tmOverhang);
    emit_field(metrics.tmItalic);
    emit_field(metrics.tmUnderlined);
    emit_field(metrics.tmStruckOut);
    emit_field(metrics.tmFirstChar);
    emit_field(metrics.tmLastChar);
    emit_field(metrics.tmDefaultChar);
    emit_field(metrics.tmBreakChar);
    emit_field(metrics.tmPitchAndFamily);
    emit_field(metrics.tmCharSet);
    emit("\r\n");

    /* GetCharWidth32A is documented as Windows NT only; on Win98 it resolves
     * and returns FALSE, so the widths come from the Win9x entry point. */
    if (GetCharWidthA(dc, 0x20, 0x7E, widths)) {
      emit("CW");
      emit_field(request);
      for (index = 0; index < 95; index++) emit_field(widths[index]);
      emit("\r\n");
    }

    for (index = 0; index < (int)(sizeof(strings) / sizeof(strings[0])); index++) {
      SIZE size;
      if (!GetTextExtentPoint32A(dc, strings[index],
            lstrlenA(strings[index]), &size)) continue;
      emit("EX");
      emit_field(request);
      emit_field(size.cx);
      emit_field(size.cy);
      emit_field(index);
      emit("\r\n");
    }

    SelectObject(dc, old);
    DeleteObject(font);
  }
}

void WINAPI WinMainCRTStartup(void) {
  HDC dc;
  int index;

  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  dc = GetDC(NULL);

  emit("STRINGS\r\n");
  for (index = 0; index < (int)(sizeof(strings) / sizeof(strings[0])); index++) {
    emit_int(index);
    emit(" ");
    emit(strings[index]);
    emit("\r\n");
  }

  for (index = 0; index < (int)(sizeof(faces) / sizeof(faces[0])); index++) {
    emit_face(dc, faces[index]);
  }
  emit("END\r\n");

  ReleaseDC(NULL, dc);
  if (serial != INVALID_HANDLE_VALUE) CloseHandle(serial);
  ExitProcess(0);
}
