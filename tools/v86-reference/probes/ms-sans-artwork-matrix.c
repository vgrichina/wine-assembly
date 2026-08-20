#include <windows.h>

/*
 * Dense MS Sans Serif artwork ladder shared by native Windows 98 and
 * wine-assembly.  The chosen requests straddle every interesting mapper
 * boundary, including the synthetic 24px rung used by -18 and doubled by
 * -36.  Pass NATIVE to load a locally mounted SSERIFE.FON.
 */

unsigned long _tls_index = 0;

static const int requests[] = {
  12, 13, 15, 16, 17,
  18, 20, 21, 22, 23,
  24, 25, 26, 30, 31,
  35, 36, 38, 39, 48
};

static int added_font;
static int original_system_font;

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

static void text(HDC dc, int x, int y, const char *value) {
  TextOutA(dc, x, y, value, lstrlenA(value));
}

static void line(HDC dc, int x0, int y0, int x1, int y1) {
  MoveToEx(dc, x0, y0, NULL);
  LineTo(dc, x1, y1);
}

static void paint_matrix(HDC dc) {
  HFONT label_font = (HFONT)GetStockObject(SYSTEM_FIXED_FONT);
  HPEN grid_pen = CreatePen(PS_SOLID, 1, RGB(208, 208, 208));
  HGDIOBJ old_pen;
  char title[96];
  int index;

  PatBlt(dc, 0, 0, 640, 480, WHITENESS);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(0, 0, 0));
  SetTextAlign(dc, TA_LEFT | TA_TOP);
  SelectObject(dc, label_font);
  if (added_font)
    wsprintfA(title, "ORIGINAL MICROSOFT SSERIFE.FON (loaded=%d)", added_font);
  else if (original_system_font)
    lstrcpynA(title, "NATIVE WINDOWS 98 MICROSOFT SSERIFE.FON", sizeof(title));
  else
    lstrcpynA(title, "WINE OPEN SUBSTITUTE: NATIVE 13/16/20 STRIKES", sizeof(title));
  text(dc, 6, 4, title);
  text(dc, 6, 22, "label: requested px -> selected cell px; 20 sizes; sample: Ag09");

  old_pen = SelectObject(dc, grid_pen);
  for (index = 1; index < 5; index++) line(dc, index * 128, 40, index * 128, 480);
  for (index = 0; index < 4; index++) line(dc, 0, 40 + index * 110, 640, 40 + index * 110);

  for (index = 0; index < (int)(sizeof(requests) / sizeof(requests[0])); index++) {
    int column = index % 5;
    int row = index / 5;
    int x = column * 128 + 5;
    int y = 44 + row * 110;
    int request = requests[index];
    HFONT font = CreateFontA(-request, 0, 0, 0, FW_NORMAL,
      FALSE, FALSE, FALSE, ANSI_CHARSET, OUT_DEFAULT_PRECIS,
      CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
      "MS Sans Serif");
    HFONT old_font = (HFONT)SelectObject(dc, font);
    TEXTMETRICA metrics;
    SIZE extent;
    char label[48];

    GetTextMetricsA(dc, &metrics);
    GetTextExtentPoint32A(dc, "Ag09", 4, &extent);
    SelectObject(dc, label_font);
    wsprintfA(label, "-%d -> %dpx", request, metrics.tmHeight);
    text(dc, x, y, label);

    SelectObject(dc, font);
    text(dc, x, y + 18, "Ag09");
    SelectObject(dc, old_font);
    DeleteObject(font);
  }

  SelectObject(dc, old_pen);
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

void WINAPI WinMainCRTStartup(void) {
  WNDCLASSA cls;
  HWND window;
  MSG message;

  if (contains_word(GetCommandLineA(), "NATIVE"))
    added_font = AddFontResourceA("C:\\NATIVE-FONTS\\SSERIFE.FON");
  else if (contains_word(GetCommandLineA(), "ORIGINAL"))
    original_system_font = 1;

  zero_bytes(&cls, sizeof(cls));
  cls.style = CS_HREDRAW | CS_VREDRAW;
  cls.lpfnWndProc = window_proc;
  cls.hInstance = GetModuleHandleA(NULL);
  cls.hCursor = LoadCursorA(NULL, IDC_ARROW);
  cls.lpszClassName = "MsSansArtworkMatrix";
  RegisterClassA(&cls);
  ShowCursor(FALSE);
  window = CreateWindowExA(0, cls.lpszClassName, "MS Sans artwork matrix",
    WS_POPUP | WS_VISIBLE, 0, 0, 640, 480, NULL, NULL, cls.hInstance, NULL);
  ShowWindow(window, SW_SHOW);
  UpdateWindow(window);
  while (GetMessageA(&message, NULL, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageA(&message);
  }
  ExitProcess(0);
}
