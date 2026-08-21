#include <windows.h>

/*
 * Resolve every negative MS Sans Serif LOGFONT height from -1 through -48.
 * The same executable runs in native Windows 98 and wine-assembly. Native
 * metrics are emitted over COM1 and painted in a compact two-column table so
 * strike-selection and integer-magnification boundaries are both machine-
 * readable and visible in a VGA capture.
 */

unsigned long _tls_index = 0;

static HANDLE serial;
static int added_font;

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

static void emit(const char *text) {
  DWORD written;
  if (serial != INVALID_HANDLE_VALUE)
    WriteFile(serial, text, (DWORD)lstrlenA(text), &written, NULL);
}

static void measure(HDC dc, int request, TEXTMETRICA *metrics, SIZE *extent) {
  HFONT font = CreateFontA(-request, 0, 0, 0, FW_NORMAL,
    FALSE, FALSE, FALSE, ANSI_CHARSET, OUT_DEFAULT_PRECIS,
    CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
    "MS Sans Serif");
  HFONT old = (HFONT)SelectObject(dc, font);
  GetTextMetricsA(dc, metrics);
  GetTextExtentPoint32A(dc, "Ag09Wm", 6, extent);
  SelectObject(dc, old);
  DeleteObject(font);
}

static void emit_sweep(HDC dc) {
  int request;
  char line[128];
  emit("MS_SANS_NEGATIVE_HEIGHT_SWEEP\r\n");
  for (request = 1; request <= 48; request++) {
    TEXTMETRICA metrics;
    SIZE extent;
    measure(dc, request, &metrics, &extent);
    wsprintfA(line, "ROW -%d %d %d %d %d %d %d %d\r\n",
      request, metrics.tmHeight, metrics.tmAscent, metrics.tmDescent,
      metrics.tmInternalLeading, metrics.tmAveCharWidth, extent.cx, extent.cy);
    emit(line);
  }
  emit("END\r\n");
}

static void text(HDC dc, int x, int y, const char *value) {
  TextOutA(dc, x, y, value, lstrlenA(value));
}

static void paint_sweep(HDC dc) {
  HFONT label_font = (HFONT)GetStockObject(SYSTEM_FIXED_FONT);
  HGDIOBJ old_font = SelectObject(dc, label_font);
  int request;
  char line[96];

  PatBlt(dc, 0, 0, 640, 480, WHITENESS);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(0, 0, 0));
  wsprintfA(line, "MS Sans Serif negative LOGFONT sweep; AddFontResource=%d",
    added_font);
  text(dc, 5, 3, line);
  text(dc, 5, 21, "req  cell asc des int avg extent     req  cell asc des int avg extent");

  for (request = 1; request <= 48; request++) {
    TEXTMETRICA metrics;
    SIZE extent;
    int slot = request - 1;
    int x = slot < 24 ? 5 : 325;
    int y = 39 + (slot % 24) * 18;
    measure(dc, request, &metrics, &extent);
    wsprintfA(line, "-%02d  %02d  %02d  %02d  %02d  %02d  %03dx%02d",
      request, metrics.tmHeight, metrics.tmAscent, metrics.tmDescent,
      metrics.tmInternalLeading, metrics.tmAveCharWidth, extent.cx, extent.cy);
    text(dc, x, y, line);
  }
  SelectObject(dc, old_font);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message,
    WPARAM wparam, LPARAM lparam) {
  (void)wparam;
  (void)lparam;
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);
    paint_sweep(dc);
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
  HDC dc;

  if (contains_word(GetCommandLineA(), "NATIVE"))
    added_font = AddFontResourceA("C:\\NATIVE-FONTS\\SSERIFE.FON");

  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  dc = GetDC(NULL);
  emit_sweep(dc);
  ReleaseDC(NULL, dc);
  if (serial != INVALID_HANDLE_VALUE) CloseHandle(serial);

  zero_bytes(&cls, sizeof(cls));
  cls.style = CS_HREDRAW | CS_VREDRAW;
  cls.lpfnWndProc = window_proc;
  cls.hInstance = GetModuleHandleA(NULL);
  cls.hCursor = LoadCursorA(NULL, IDC_ARROW);
  cls.lpszClassName = "MsSansSizeSweep";
  RegisterClassA(&cls);
  window = CreateWindowExA(0, cls.lpszClassName, "MS Sans size sweep",
    WS_POPUP | WS_VISIBLE, 0, 0, 640, 480, NULL, NULL, cls.hInstance, NULL);
  ShowWindow(window, SW_SHOW);
  UpdateWindow(window);
  while (GetMessageA(&message, NULL, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageA(&message);
  }
  ExitProcess(0);
}
