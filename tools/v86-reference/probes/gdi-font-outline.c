#include <windows.h>

/*
 * Native Windows 98 reference for scalable GetGlyphOutline and legacy kern.
 * The exact GLYPHMETRICS fields and returned byte streams are emitted over
 * COM1 so WAT tests can pin the Win98 contract without a host font engine.
 */

unsigned long _tls_index = 0;

static HANDLE serial;
static unsigned char glyph_data[65536];
static KERNINGPAIR kerning_pairs[4096];
static char placement_out[32];
static int placement_order[32];
static int placement_dx[32];
static int placement_caret[32];
static WCHAR placement_glyphs[32];

static void emit_n(const char *text, DWORD count) {
  DWORD written;
  if (serial != INVALID_HANDLE_VALUE)
    WriteFile(serial, text, count, &written, NULL);
}

static void emit(const char *text) {
  emit_n(text, (DWORD)lstrlenA(text));
}

static void emit_int(LONG value) {
  char digits[16];
  int length = 0;
  ULONG magnitude;
  if (value < 0) {
    emit("-");
    magnitude = (ULONG)(-(value + 1)) + 1;
  } else {
    magnitude = (ULONG)value;
  }
  do {
    digits[length++] = (char)('0' + magnitude % 10);
    magnitude /= 10;
  } while (magnitude);
  while (length) emit_n(&digits[--length], 1);
}

static void emit_hex_byte(unsigned char value) {
  static const char digits[] = "0123456789ABCDEF";
  char pair[2];
  pair[0] = digits[value >> 4];
  pair[1] = digits[value & 15];
  emit_n(pair, 2);
}

static void emit_metrics(const GLYPHMETRICS *metrics) {
  emit(" metrics=");
  emit_int((LONG)metrics->gmBlackBoxX); emit(",");
  emit_int((LONG)metrics->gmBlackBoxY); emit(",");
  emit_int(metrics->gmptGlyphOrigin.x); emit(",");
  emit_int(metrics->gmptGlyphOrigin.y); emit(",");
  emit_int(metrics->gmCellIncX); emit(",");
  emit_int(metrics->gmCellIncY);
}

static void emit_outline_case(HDC dc, UINT character, UINT format,
                              const MAT2 *matrix, const char *matrix_name) {
  GLYPHMETRICS metrics;
  DWORD needed;
  DWORD result;
  DWORD i;

  ZeroMemory(&metrics, sizeof(metrics));
  needed = GetGlyphOutlineA(dc, character, format, &metrics, 0, NULL, matrix);
  emit("CASE char="); emit_int((LONG)character);
  emit(" format="); emit_int((LONG)format);
  emit(" matrix="); emit(matrix_name);
  emit(" needed="); emit_int((LONG)needed);
  emit_metrics(&metrics);
  emit("\r\n");

  if (needed != GDI_ERROR && needed > 0 && needed <= sizeof(glyph_data)) {
    ZeroMemory(glyph_data, sizeof(glyph_data));
    result = GetGlyphOutlineA(dc, character, format, &metrics,
                             needed, glyph_data, matrix);
    emit("RESULT bytes="); emit_int((LONG)result);
    emit_metrics(&metrics);
    emit(" data=");
    for (i = 0; i < result && i < needed; ++i) emit_hex_byte(glyph_data[i]);
    emit("\r\n");
  }
  emit("ENDCASE\r\n");
}

static void emit_kerning(HDC dc) {
  static const WORD wanted[][2] = {
    {'A', 'V'}, {'A', 'W'}, {'T', 'o'}, {'W', 'a'}, {'Y', 'o'}, {'f', 'i'}
  };
  DWORD total = GetKerningPairsA(dc, 0, NULL);
  DWORD capacity = total;
  DWORD copied;
  DWORD i;
  DWORD j;
  if (capacity > 4096) capacity = 4096;
  copied = GetKerningPairsA(dc, capacity, kerning_pairs);
  emit("KERN total="); emit_int((LONG)total);
  emit(" copied="); emit_int((LONG)copied); emit("\r\n");
  for (j = 0; j < sizeof(wanted) / sizeof(wanted[0]); ++j) {
    LONG amount = 0;
    int found = 0;
    for (i = 0; i < copied; ++i) {
      if (kerning_pairs[i].wFirst == wanted[j][0] &&
          kerning_pairs[i].wSecond == wanted[j][1]) {
        amount = kerning_pairs[i].iKernAmount;
        found = 1;
        break;
      }
    }
    emit("PAIR first="); emit_int((LONG)wanted[j][0]);
    emit(" second="); emit_int((LONG)wanted[j][1]);
    emit(" found="); emit_int(found);
    emit(" amount="); emit_int(amount); emit("\r\n");
  }
}

static void emit_placement(HDC dc, const char *text, DWORD flags) {
  GCP_RESULTSA results;
  DWORD packed;
  int length = lstrlenA(text);
  int i;
  ZeroMemory(&results, sizeof(results));
  ZeroMemory(placement_out, sizeof(placement_out));
  ZeroMemory(placement_order, sizeof(placement_order));
  ZeroMemory(placement_dx, sizeof(placement_dx));
  ZeroMemory(placement_caret, sizeof(placement_caret));
  ZeroMemory(placement_glyphs, sizeof(placement_glyphs));
  results.lStructSize = sizeof(results);
  results.lpOutString = placement_out;
  results.lpOrder = placement_order;
  results.lpDx = placement_dx;
  results.lpCaretPos = placement_caret;
  results.lpGlyphs = placement_glyphs;
  results.nGlyphs = length;
  packed = GetCharacterPlacementA(dc, text, length, 32767, &results, flags);
  emit("GCP text="); emit(text);
  emit(" flags="); emit_int((LONG)flags);
  emit(" packed="); emit_int((LONG)packed);
  emit(" glyphs="); emit_int((LONG)results.nGlyphs);
  emit(" dx=");
  for (i = 0; i < (int)results.nGlyphs; ++i) {
    if (i) emit(",");
    emit_int(placement_dx[i]);
  }
  emit(" caret=");
  for (i = 0; i < (int)results.nGlyphs; ++i) {
    if (i) emit(",");
    emit_int(placement_caret[i]);
  }
  emit("\r\n");
}

void WINAPI WinMainCRTStartup(void) {
  static const UINT characters[] = {'A', 'g', 0xE9};
  static const UINT formats[] = {
    GGO_METRICS, GGO_BITMAP, GGO_NATIVE, GGO_BEZIER,
    GGO_GRAY2_BITMAP, GGO_GRAY4_BITMAP, GGO_GRAY8_BITMAP,
    GGO_BITMAP | GGO_UNHINTED, GGO_NATIVE | GGO_UNHINTED
  };
  MAT2 identity;
  MAT2 shear;
  HDC dc;
  HFONT font;
  HFONT old_font;
  char face[LF_FACESIZE];
  int character;
  int format;

  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  emit("GDI_FONT_OUTLINE_V1\r\n");

  dc = CreateCompatibleDC(NULL);
  font = CreateFontA(-24, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
    ANSI_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY,
    DEFAULT_PITCH | FF_DONTCARE, "Arial");
  old_font = (HFONT)SelectObject(dc, font);
  ZeroMemory(face, sizeof(face));
  GetTextFaceA(dc, sizeof(face), face);
  emit("FACE requested=Arial selected="); emit(face); emit(" height=-24\r\n");

  ZeroMemory(&identity, sizeof(identity));
  identity.eM11.value = 1;
  identity.eM22.value = 1;
  ZeroMemory(&shear, sizeof(shear));
  shear.eM11.value = 1;
  shear.eM21.fract = 0x4000;
  shear.eM22.value = 1;

  for (character = 0; character < (int)(sizeof(characters) / sizeof(characters[0])); ++character) {
    for (format = 0; format < (int)(sizeof(formats) / sizeof(formats[0])); ++format)
      emit_outline_case(dc, characters[character], formats[format], &identity, "identity");
  }
  emit_outline_case(dc, 'A', GGO_NATIVE, &shear, "shear-quarter");
  emit_outline_case(dc, 'A', GGO_BITMAP, &shear, "shear-quarter");
  emit_kerning(dc);
  emit_placement(dc, "AV", 0);
  emit_placement(dc, "AV", GCP_USEKERNING);
  emit_placement(dc, "To", 0);
  emit_placement(dc, "To", GCP_USEKERNING);

  SelectObject(dc, old_font);
  DeleteObject(font);
  DeleteDC(dc);
  emit("GDI_FONT_OUTLINE_DONE\r\n");
  if (serial != INVALID_HANDLE_VALUE) CloseHandle(serial);
  ExitProcess(0);
}
