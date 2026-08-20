#include <windows.h>

/*
 * Visual TrueType/raster-font reference shared by native Windows 98 and
 * wine-assembly.  The borderless 640x480 window makes the two VGA captures
 * directly comparable without compensating for window-manager geometry.
 */

unsigned long _tls_index = 0;

static const char *native_faces[] = {
  "Arial",
  "Times New Roman",
  "Courier New",
  "MS Sans Serif"
};

static const char *substitute_faces[] = {
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "Liberation Sans"
};

static const char *substitute_labels[] = {
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "MS outline -> Lib Sans"
};

static const int heights[] = { -12, -18, -26, -36 };
static const char **faces = native_faces;
static const char **labels = native_faces;
static const char *mode_title = "Native Win98 face names";
static int installed_fonts;

static void zero_bytes(void *memory, int length) {
  volatile unsigned char *out = (volatile unsigned char *)memory;
  while (length-- > 0) *out++ = 0;
}

static int contains_word(const char *text, const char *word) {
  int index;
  int length = lstrlenA(word);
  while (*text) {
    for (index = 0; index < length && text[index] == word[index]; index++) {}
    if (index == length) return 1;
    text++;
  }
  return 0;
}

static int file_exists(const char *path) {
  return GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES;
}

static int add_first_font(const char *primary, const char *fallback) {
  if (file_exists(primary)) return AddFontResourceA(primary);
  if (fallback && file_exists(fallback)) return AddFontResourceA(fallback);
  return 0;
}

static void configure_fonts(void) {
  const char *command = GetCommandLineA();
  if (contains_word(command, "SUBSTITUTES")) {
    faces = substitute_faces;
    labels = substitute_labels;
    mode_title = "Open substitutes (same bytes in both renderers)";
    installed_fonts += add_first_font("D:\\LIBSANS.TTF",
      "C:\\WINDOWS\\FONTS\\ARIAL.TTF");
    installed_fonts += add_first_font("D:\\LIBSERIF.TTF",
      "C:\\WINDOWS\\FONTS\\TIMES.TTF");
    installed_fonts += add_first_font("D:\\LIBMONO.TTF",
      "C:\\WINDOWS\\FONTS\\COUR.TTF");
  } else if (contains_word(command, "NATIVE")) {
    mode_title = "Locally supplied native Win98 font bytes";
    installed_fonts += add_first_font("C:\\NATIVE-FONTS\\ARIAL.TTF", NULL);
    installed_fonts += add_first_font("C:\\NATIVE-FONTS\\TIMES.TTF", NULL);
    installed_fonts += add_first_font("C:\\NATIVE-FONTS\\COUR.TTF", NULL);
    installed_fonts += add_first_font("C:\\NATIVE-FONTS\\SSERIFE.FON", NULL);
  }
}

static void text(HDC dc, int x, int y, const char *value) {
  TextOutA(dc, x, y, value, lstrlenA(value));
}

static void line(HDC dc, int x0, int y0, int x1, int y1) {
  MoveToEx(dc, x0, y0, NULL);
  LineTo(dc, x1, y1);
}

static void paint_matrix(HDC dc) {
  static const int row_tops[] = { 66, 152, 248, 352 };
  char title[96];
  HFONT label_font = (HFONT)GetStockObject(SYSTEM_FONT);
  HPEN grid_pen = CreatePen(PS_SOLID, 1, RGB(192, 192, 192));
  HPEN metric_pen = CreatePen(PS_SOLID, 1, RGB(0, 0, 255));
  HPEN baseline_pen = CreatePen(PS_SOLID, 1, RGB(255, 0, 0));
  HGDIOBJ old_pen;
  int column;
  int row;

  PatBlt(dc, 0, 0, 640, 480, WHITENESS);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(0, 0, 0));
  SetTextAlign(dc, TA_LEFT | TA_TOP);
  SelectObject(dc, label_font);
  if (installed_fonts)
    wsprintfA(title, "%s; AddFontResource=%d", mode_title, installed_fonts);
  else
    lstrcpynA(title, mode_title, sizeof(title));
  text(dc, 8, 5, title);
  text(dc, 8, 23, "red=baseline  blue=ascent/descent box  request heights: -12 -18 -26 -36");

  old_pen = SelectObject(dc, grid_pen);
  for (column = 1; column < 4; column++) line(dc, column * 160, 45, column * 160, 480);
  for (row = 0; row < 4; row++) line(dc, 0, row_tops[row] - 7, 640, row_tops[row] - 7);

  for (column = 0; column < 4; column++) {
    int x = column * 160 + 6;
    SelectObject(dc, label_font);
    SetTextAlign(dc, TA_LEFT | TA_TOP);
    text(dc, x, 47, labels[column]);

    for (row = 0; row < 4; row++) {
      HFONT font = CreateFontA(heights[row], 0, 0, 0, FW_NORMAL,
        FALSE, FALSE, FALSE, ANSI_CHARSET, OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
        faces[column]);
      HFONT old_font = (HFONT)SelectObject(dc, font);
      TEXTMETRICA metrics;
      SIZE extent;
      char label[48];
      int top = row_tops[row];
      int baseline;

      GetTextMetricsA(dc, &metrics);
      GetTextExtentPoint32A(dc, "Ag09Wm", 6, &extent);
      baseline = top + metrics.tmAscent + 19;

      SelectObject(dc, label_font);
      SetTextAlign(dc, TA_LEFT | TA_TOP);
      wsprintfA(label, "%dpx -> %dx%d", -heights[row],
        extent.cx, metrics.tmHeight);
      text(dc, x, top, label);

      SelectObject(dc, metric_pen);
      Rectangle(dc, x - 1, baseline - metrics.tmAscent - 1,
        x + extent.cx + 1, baseline + metrics.tmDescent + 1);
      SelectObject(dc, baseline_pen);
      line(dc, x - 3, baseline, column * 160 + 156, baseline);

      SelectObject(dc, font);
      SetTextAlign(dc, TA_LEFT | TA_BASELINE);
      text(dc, x, baseline, "Ag09Wm");

      SelectObject(dc, old_font);
      DeleteObject(font);
    }
  }

  SetTextAlign(dc, TA_LEFT | TA_TOP);
  SelectObject(dc, old_pen);
  DeleteObject(baseline_pen);
  DeleteObject(metric_pen);
  DeleteObject(grid_pen);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message,
    WPARAM wparam, LPARAM lparam) {
  (void)wparam;
  (void)lparam;
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);
    paint_matrix(dc);
    EndPaint(window, &paint);
    return 0;
  }
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcA(window, message, wparam, lparam);
}

static int run_probe(void) {
  HINSTANCE instance = GetModuleHandleA(NULL);
  WNDCLASSA cls;
  MSG message;
  HWND window;

  zero_bytes(&cls, sizeof(cls));
  cls.style = CS_HREDRAW | CS_VREDRAW;
  cls.lpfnWndProc = window_proc;
  cls.hInstance = instance;
  cls.hCursor = NULL;
  cls.hbrBackground = (HBRUSH)GetStockObject(WHITE_BRUSH);
  cls.lpszClassName = "FontRenderMatrixReference";
  RegisterClassA(&cls);

  configure_fonts();
  ShowCursor(FALSE);
  window = CreateWindowA(cls.lpszClassName, "Font render matrix",
    WS_POPUP | WS_VISIBLE, 0, 0, 640, 480,
    NULL, NULL, instance, NULL);
  ShowWindow(window, SW_SHOWMAXIMIZED);
  UpdateWindow(window);

  while (GetMessageA(&message, NULL, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageA(&message);
  }
  return (int)message.wParam;
}

void WINAPI WinMainCRTStartup(void) {
  ExitProcess((UINT)run_probe());
}
