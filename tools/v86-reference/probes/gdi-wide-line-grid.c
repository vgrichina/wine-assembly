#include <windows.h>

/*
 * Native Windows 98 reference grid for wide cosmetic CreatePen/LineTo
 * coverage. Width 1 records the native center-line walk used to interpret the
 * width 2..5 masks. Each 24x24 top-down 32-bpp DIB is emitted over COM1 as an
 * exact one-bit pixel mask. The vectors cover every direction and several slopes.
 */

unsigned long _tls_index = 0;

static HANDLE serial;

static LONG cross(const POINT *o, const POINT *a, const POINT *b) {
  return (a->x - o->x) * (b->y - o->y) - (a->y - o->y) * (b->x - o->x);
}

static int convex_hull(POINT *points, int count, POINT *out) {
  POINT unique[8];
  int unique_count = 0;
  int i;
  int j;
  int lower;
  int out_count = 0;
  for (i = 0; i < count; ++i) {
    for (j = i + 1; j < count; ++j) {
      if (points[j].x < points[i].x ||
          (points[j].x == points[i].x && points[j].y < points[i].y)) {
        POINT swap = points[i];
        points[i] = points[j];
        points[j] = swap;
      }
    }
  }
  for (i = 0; i < count; ++i) {
    if (!unique_count || points[i].x != unique[unique_count - 1].x ||
        points[i].y != unique[unique_count - 1].y)
      unique[unique_count++] = points[i];
  }
  for (i = 0; i < unique_count; ++i) {
    while (out_count >= 2 && cross(&out[out_count - 2], &out[out_count - 1], &unique[i]) <= 0)
      --out_count;
    out[out_count++] = unique[i];
  }
  lower = out_count;
  for (i = unique_count - 2; i >= 0; --i) {
    while (out_count > lower && cross(&out[out_count - 2], &out[out_count - 1], &unique[i]) <= 0)
      --out_count;
    out[out_count++] = unique[i];
  }
  if (out_count > 1) --out_count;
  return out_count;
}

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

static void emit_case(int width, int x0, int y0, int x1, int y1) {
  BITMAPINFO info;
  HDC dc;
  HBITMAP bitmap;
  HBITMAP old_bitmap;
  HPEN pen;
  HPEN old_pen;
  unsigned char *bits = NULL;
  unsigned char *hull_bits = NULL;
  HDC hull_dc;
  HBITMAP hull_bitmap;
  HBITMAP old_hull_bitmap;
  HBRUSH hull_brush;
  HBRUSH old_hull_brush;
  HPEN old_hull_pen;
  POINT corners[8];
  POINT hull[16];
  int hull_count;
  int half;
  int far_extent;
  int differences = 0;
  int x;
  int y;

  ZeroMemory(&info, sizeof(info));
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = 24;
  info.bmiHeader.biHeight = -24;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  dc = CreateCompatibleDC(NULL);
  bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, (void **)&bits, NULL, 0);
  old_bitmap = (HBITMAP)SelectObject(dc, bitmap);
  PatBlt(dc, 0, 0, 24, 24, BLACKNESS);
  pen = CreatePen(PS_SOLID, width, RGB(0xff, 0xff, 0xff));
  old_pen = (HPEN)SelectObject(dc, pen);
  SetROP2(dc, R2_COPYPEN);
  MoveToEx(dc, x0, y0, NULL);
  LineTo(dc, x1, y1);

  emit("CASE width="); emit_int(width);
  emit(" line="); emit_int(x0); emit(","); emit_int(y0);
  emit(","); emit_int(x1); emit(","); emit_int(y1); emit("\r\n");
  for (y = 0; y < 24; ++y) {
    for (x = 0; x < 24; ++x) {
      unsigned char *pixel = bits + (y * 24 + x) * 4;
      emit((pixel[0] || pixel[1] || pixel[2]) ? "#" : ".");
    }
    emit("\r\n");
  }
  emit("ENDCASE\r\n");

  half = width / 2;
  far_extent = width - half;
  corners[0].x = x0 - half; corners[0].y = y0 - half;
  corners[1].x = x0 + far_extent;  corners[1].y = y0 - half;
  corners[2].x = x0 + far_extent;  corners[2].y = y0 + far_extent;
  corners[3].x = x0 - half; corners[3].y = y0 + far_extent;
  corners[4].x = x1 - half; corners[4].y = y1 - half;
  corners[5].x = x1 + far_extent;  corners[5].y = y1 - half;
  corners[6].x = x1 + far_extent;  corners[6].y = y1 + far_extent;
  corners[7].x = x1 - half; corners[7].y = y1 + far_extent;
  hull_count = convex_hull(corners, 8, hull);
  hull_dc = CreateCompatibleDC(NULL);
  hull_bitmap = CreateDIBSection(hull_dc, &info, DIB_RGB_COLORS,
    (void **)&hull_bits, NULL, 0);
  old_hull_bitmap = (HBITMAP)SelectObject(hull_dc, hull_bitmap);
  PatBlt(hull_dc, 0, 0, 24, 24, BLACKNESS);
  hull_brush = CreateSolidBrush(RGB(0xff, 0xff, 0xff));
  old_hull_brush = (HBRUSH)SelectObject(hull_dc, hull_brush);
  old_hull_pen = (HPEN)SelectObject(hull_dc, GetStockObject(NULL_PEN));
  Polygon(hull_dc, hull, hull_count);
  for (y = 0; y < 24; ++y) {
    for (x = 0; x < 24; ++x) {
      int offset = (y * 24 + x) * 4;
      int line_on = bits[offset] || bits[offset + 1] || bits[offset + 2];
      int hull_on = hull_bits[offset] || hull_bits[offset + 1] || hull_bits[offset + 2];
      if (line_on != hull_on) ++differences;
    }
  }
  emit("HULLDIFF "); emit_int(differences); emit("\r\n");
  SelectObject(hull_dc, old_hull_pen);
  SelectObject(hull_dc, old_hull_brush);
  SelectObject(hull_dc, old_hull_bitmap);
  DeleteObject(hull_brush);
  DeleteObject(hull_bitmap);
  DeleteDC(hull_dc);

  SelectObject(dc, old_pen);
  SelectObject(dc, old_bitmap);
  DeleteObject(pen);
  DeleteObject(bitmap);
  DeleteDC(dc);
}

void WINAPI WinMainCRTStartup(void) {
  static const POINT vectors[] = {
    {1, 1}, {2, 1}, {3, 1}, {3, 2}, {4, 1},
    {4, 3}, {5, 2}, {5, 3}, {6, 1}, {6, 5},
    {7, 3}, {7, 7}, {3, 9}, {7, 6}
  };
  int width;
  int vector;
  int swap;
  int sx;
  int sy;

  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  emit("GDI_WIDE_LINE_GRID_V1\r\n");
  for (width = 1; width <= 5; ++width) {
    for (vector = 0; vector < (int)(sizeof(vectors) / sizeof(vectors[0])); ++vector) {
      for (swap = 0; swap < 2; ++swap) {
        int dx = swap ? vectors[vector].y : vectors[vector].x;
        int dy = swap ? vectors[vector].x : vectors[vector].y;
        for (sx = -1; sx <= 1; sx += 2) {
          for (sy = -1; sy <= 1; sy += 2) {
            emit_case(width, 12, 12, 12 + sx * dx, 12 + sy * dy);
          }
        }
      }
    }
  }
  emit("GDI_WIDE_LINE_GRID_DONE\r\n");
  if (serial != INVALID_HANDLE_VALUE) CloseHandle(serial);
  ExitProcess(0);
}
