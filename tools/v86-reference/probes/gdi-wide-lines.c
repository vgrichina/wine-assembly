#include <windows.h>

/*
 * Native Windows 98 reference probe for CreatePen/LineTo wide strokes.
 *
 * The v86 harness captures COM1, so this emits exact top-down DIB masks rather
 * than relying on screenshot scaling or palette conversion.  '#' is the exact
 * requested pen color, '.' is black, and '?' is any unexpected pixel value.
 */

unsigned long _tls_index = 0;

static HANDLE serial;
static DWORD ext_pen_style;

static void emit_n(const char *text, DWORD count) {
  DWORD written;
  if (serial != INVALID_HANDLE_VALUE) WriteFile(serial, text, count, &written, NULL);
}

static void emit(const char *text) {
  emit_n(text, (DWORD)lstrlenA(text));
}

static void emit_uint(unsigned int value) {
  char digits[16];
  int length = 0;
  do {
    digits[length++] = (char)('0' + value % 10);
    value /= 10;
  } while (value);
  while (length) emit_n(&digits[--length], 1);
}

static void emit_case(const char *name, int width, int height, int pen_width,
    int x0, int y0, int x1, int y1) {
  BITMAPINFO info;
  HDC dc;
  HBITMAP bitmap;
  HBITMAP old_bitmap;
  HPEN pen;
  HPEN old_pen;
  unsigned char *bits = NULL;
  int x;
  int y;

  ZeroMemory(&info, sizeof(info));
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  dc = CreateCompatibleDC(NULL);
  bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, (void **)&bits, NULL, 0);
  old_bitmap = (HBITMAP)SelectObject(dc, bitmap);
  PatBlt(dc, 0, 0, width, height, BLACKNESS);
  if (ext_pen_style) {
    LOGBRUSH brush;
    brush.lbStyle = BS_SOLID;
    brush.lbColor = RGB(0x33, 0x22, 0x11);
    brush.lbHatch = 0;
    pen = ExtCreatePen(ext_pen_style, pen_width, &brush, 0, NULL);
  } else {
    pen = CreatePen(PS_SOLID, pen_width, RGB(0x33, 0x22, 0x11));
  }
  old_pen = (HPEN)SelectObject(dc, pen);
  MoveToEx(dc, x0, y0, NULL);
  LineTo(dc, x1, y1);
  GdiFlush();

  emit("CASE ");
  emit(name);
  emit(" size=");
  emit_uint((unsigned int)width);
  emit("x");
  emit_uint((unsigned int)height);
  emit(" pen=");
  emit_uint((unsigned int)pen_width);
  emit(" line=");
  emit_uint((unsigned int)x0);
  emit(",");
  emit_uint((unsigned int)y0);
  emit("-");
  emit_uint((unsigned int)x1);
  emit(",");
  emit_uint((unsigned int)y1);
  emit("\r\n");

  for (y = 0; y < height; y++) {
    for (x = 0; x < width; x++) {
      unsigned char *pixel = bits + (y * width + x) * 4;
      char mark = '.';
      if (pixel[0] == 0x11 && pixel[1] == 0x22 && pixel[2] == 0x33)
        mark = '#';
      else if (pixel[0] || pixel[1] || pixel[2])
        mark = '?';
      emit_n(&mark, 1);
    }
    emit("\r\n");
  }
  emit("ENDCASE\r\n");

  SelectObject(dc, old_pen);
  SelectObject(dc, old_bitmap);
  DeleteObject(pen);
  DeleteObject(bitmap);
  DeleteDC(dc);
}

void WINAPI WinMainCRTStartup(void) {
  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  emit("GDI_WIDE_LINES_V1\r\n");
  emit_case("w2_shallow_positive", 12, 9, 2, 2, 2, 9, 5);
  emit_case("w3_diagonal", 12, 12, 3, 2, 2, 9, 9);
  emit_case("w4_steep_positive", 11, 12, 4, 3, 1, 6, 10);
  emit_case("w5_reverse_negative", 13, 11, 5, 10, 2, 3, 8);
  emit_case("w3_reverse_horizontal", 13, 8, 3, 10, 4, 3, 4);
  emit_case("w3_forward_horizontal", 10, 8, 3, 2, 3, 7, 3);
  emit_case("w4_clipped_horizontal", 7, 6, 4, 0, 1, 4, 1);
  emit_case("w2_forward_vertical", 8, 11, 2, 4, 2, 4, 8);
  emit_case("w4_reverse_vertical", 9, 12, 4, 5, 9, 5, 3);
  emit_case("w5_short_horizontal", 12, 12, 5, 5, 5, 6, 5);
  emit_case("w5_short_diagonal", 12, 12, 5, 5, 5, 6, 6);
  emit_case("w10_short_horizontal", 18, 16, 10, 8, 8, 9, 8);
  emit_case("w10_short_diagonal", 18, 16, 10, 8, 8, 9, 9);
  emit_case("w10_long_shallow", 22, 18, 10, 4, 4, 17, 11);
  ext_pen_style = PS_GEOMETRIC | PS_SOLID | PS_ENDCAP_FLAT | PS_JOIN_ROUND;
  emit_case("ext_flat_w2_shallow", 12, 9, 2, 2, 2, 9, 5);
  emit_case("ext_flat_w3_diagonal", 12, 12, 3, 2, 2, 9, 9);
  emit_case("ext_flat_w5_reverse", 13, 11, 5, 10, 2, 3, 8);
  emit_case("ext_flat_w10_short", 18, 16, 10, 8, 8, 9, 8);
  ext_pen_style = PS_GEOMETRIC | PS_SOLID | PS_ENDCAP_ROUND | PS_JOIN_ROUND;
  emit_case("ext_round_w10_short", 18, 16, 10, 8, 8, 9, 8);
  ext_pen_style = PS_GEOMETRIC | PS_SOLID | PS_ENDCAP_SQUARE | PS_JOIN_ROUND;
  emit_case("ext_square_w10_short", 18, 16, 10, 8, 8, 9, 8);
  emit("GDI_WIDE_LINES_DONE\r\n");
  if (serial != INVALID_HANDLE_VALUE) CloseHandle(serial);
  ExitProcess(0);
}
