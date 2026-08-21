#include <windows.h>

/*
 * Native Windows 98 reference probe for non-idempotent ROP2 coverage on
 * wide cosmetic lines and polylines. The v86 harness captures COM1, so every
 * case is emitted from a top-down 32-bpp DIB without screenshot conversion.
 */

unsigned long _tls_index = 0;

static HANDLE serial;

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

static void draw_path(HDC dc, const POINT *points, int count, int line_to) {
  if (line_to) {
    MoveToEx(dc, points[0].x, points[0].y, NULL);
    LineTo(dc, points[1].x, points[1].y);
  } else {
    Polyline(dc, points, count);
  }
}

static void emit_case(const char *name, int width, int rop2,
    const POINT *points, int count, int line_to, int repeat) {
  BITMAPINFO info;
  HDC dc;
  HBITMAP bitmap;
  HBITMAP old_bitmap;
  HPEN pen;
  HPEN old_pen;
  unsigned char *bits = NULL;
  int x;
  int y;
  const int bitmap_width = 20;
  const int bitmap_height = 16;

  ZeroMemory(&info, sizeof(info));
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = bitmap_width;
  info.bmiHeader.biHeight = -bitmap_height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  dc = CreateCompatibleDC(NULL);
  bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, (void **)&bits, NULL, 0);
  old_bitmap = (HBITMAP)SelectObject(dc, bitmap);
  PatBlt(dc, 0, 0, bitmap_width, bitmap_height, BLACKNESS);
  pen = CreatePen(PS_SOLID, width, RGB(0xff, 0xff, 0xff));
  old_pen = (HPEN)SelectObject(dc, pen);
  SetROP2(dc, rop2);
  for (x = 0; x < repeat; x++) draw_path(dc, points, count, line_to);
  GdiFlush();

  emit("CASE ");
  emit(name);
  emit(" size=20x16 pen=");
  emit_uint((unsigned int)width);
  emit(" rop2=");
  emit_uint((unsigned int)rop2);
  emit(" points=");
  emit_uint((unsigned int)count);
  emit(" repeat=");
  emit_uint((unsigned int)repeat);
  emit("\r\n");

  for (y = 0; y < bitmap_height; y++) {
    for (x = 0; x < bitmap_width; x++) {
      unsigned char *pixel = bits + (y * bitmap_width + x) * 4;
      char mark = '.';
      if (pixel[0] == 0xff && pixel[1] == 0xff && pixel[2] == 0xff)
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
  POINT diagonal[] = {{3, 3}, {15, 10}};
  POINT vee[] = {{3, 3}, {10, 10}, {17, 3}};
  POINT collinear[] = {{2, 8}, {10, 8}, {18, 8}};
  POINT elbow[] = {{3, 3}, {10, 10}, {16, 5}};
  POINT crossing[] = {{3, 3}, {16, 12}, {3, 12}, {16, 3}};

  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  emit("GDI_ROP2_POLYLINE_V1\r\n");
  emit_case("lineto_diag_w2_not", 2, R2_NOT, diagonal, 2, 1, 1);
  emit_case("polyline_diag_w2_not", 2, R2_NOT, diagonal, 2, 0, 1);
  emit_case("polyline_vee_w2_not", 2, R2_NOT, vee, 3, 0, 1);
  emit_case("polyline_vee_w3_not", 3, R2_NOT, vee, 3, 0, 1);
  emit_case("polyline_collinear_w3_not", 3, R2_NOT, collinear, 3, 0, 1);
  emit_case("polyline_elbow_w3_xor", 3, R2_XORPEN, elbow, 3, 0, 1);
  emit_case("polyline_crossing_w3_not", 3, R2_NOT, crossing, 4, 0, 1);
  emit_case("polyline_vee_w2_not_twice", 2, R2_NOT, vee, 3, 0, 2);
  emit("GDI_ROP2_POLYLINE_DONE\r\n");
  if (serial != INVALID_HANDLE_VALUE) CloseHandle(serial);
  ExitProcess(0);
}
