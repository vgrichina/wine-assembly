#include <windows.h>

#define MAX_FONT_FILES 40
#define MAX_RASTER_FACES 40

unsigned long _tls_index = 0;

static char font_files[MAX_FONT_FILES][32];
static int font_file_count;
static char raster_faces[MAX_RASTER_FACES][LF_FACESIZE];
static int raster_heights[MAX_RASTER_FACES];
static int raster_widths[MAX_RASTER_FACES];
static int raster_face_count;
static int page;

static void inventory_files(void) {
  WIN32_FIND_DATAA data;
  HANDLE search = FindFirstFileA("C:\\WINDOWS\\FONTS\\*.FON", &data);
  if (search == INVALID_HANDLE_VALUE) return;
  do {
    if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
        font_file_count < MAX_FONT_FILES) {
      lstrcpynA(font_files[font_file_count++], data.cFileName, 32);
    }
  } while (FindNextFileA(search, &data));
  FindClose(search);
}

static int CALLBACK inventory_raster_face(const LOGFONTA *font,
    const TEXTMETRICA *metrics, DWORD type, LPARAM parameter) {
  int index;
  (void)parameter;
  if (!(type & RASTER_FONTTYPE) || raster_face_count >= MAX_RASTER_FACES)
    return 1;
  for (index = 0; index < raster_face_count; index++) {
    if (lstrcmpiA(raster_faces[index], font->lfFaceName) == 0 &&
        raster_heights[index] == metrics->tmHeight)
      return 1;
  }
  lstrcpynA(raster_faces[raster_face_count], font->lfFaceName, LF_FACESIZE);
  raster_heights[raster_face_count] = metrics->tmHeight;
  raster_widths[raster_face_count] = metrics->tmAveCharWidth;
  raster_face_count++;
  return 1;
}

static void inventory_faces(void) {
  HDC dc = GetDC(NULL);
  EnumFontFamiliesA(dc, NULL, (FONTENUMPROCA)inventory_raster_face, 0);
  ReleaseDC(NULL, dc);
}

static void text(HDC dc, int x, int y, const char *value) {
  TextOutA(dc, x, y, value, lstrlenA(value));
}

static void stock_line(HDC dc, int x, int y, int object, const char *label) {
  HFONT font = (HFONT)GetStockObject(object);
  HFONT old = (HFONT)SelectObject(dc, font);
  TEXTMETRICA metrics;
  char face[LF_FACESIZE];
  char line[128];
  GetTextMetricsA(dc, &metrics);
  GetTextFaceA(dc, LF_FACESIZE, face);
  SelectObject(dc, old);
  wsprintfA(line, "%s -> %s  %dx%d", label, face,
    metrics.tmAveCharWidth, metrics.tmHeight);
  text(dc, x, y, line);
}

static void paint_inventory(HDC dc) {
  int index;
  char line[96];
  text(dc, 8, 6, "Windows 98 installed bitmap-font reference");
  text(dc, 8, 25, "C:\\WINDOWS\\FONTS\\*.FON");
  for (index = 0; index < font_file_count; index++) {
    int column = index / 22;
    int row = index % 22;
    text(dc, 8 + column * 145, 43 + row * 16, font_files[index]);
  }
  text(dc, 304, 25, "Enumerated raster faces / first metric");
  for (index = 0; index < raster_face_count && index < 18; index++) {
    wsprintfA(line, "%s  %dx%d", raster_faces[index],
      raster_widths[index], raster_heights[index]);
    text(dc, 304, 43 + index * 16, line);
  }
  text(dc, 304, 338, "Fixed stock objects");
  stock_line(dc, 304, 356, ANSI_FIXED_FONT, "ANSI_FIXED");
  stock_line(dc, 304, 373, OEM_FIXED_FONT, "OEM_FIXED");
  stock_line(dc, 304, 390, SYSTEM_FIXED_FONT, "SYSTEM_FIXED");
  stock_line(dc, 304, 407, SYSTEM_FONT, "SYSTEM_FONT");
  text(dc, 8, 424, "Press Space for controlled Fixedsys size requests");
}

static void paint_sizes(HDC dc) {
  static const int requests[] = {16, 18, 21, 24, 32, 48, 64, 80};
  HFONT label_font = (HFONT)GetStockObject(SYSTEM_FONT);
  int y = 28;
  int index;
  text(dc, 8, 6, "Native Windows 98 GDI: CreateFontA(-height, Fixedsys)");
  for (index = 0; index < (int)(sizeof(requests) / sizeof(requests[0])); index++) {
    int request = requests[index];
    HFONT font = CreateFontA(-request, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
      ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY,
      FIXED_PITCH | FF_MODERN, "Fixedsys");
    HFONT old = (HFONT)SelectObject(dc, font);
    TEXTMETRICA metrics;
    char face[LF_FACESIZE];
    char line[128];
    GetTextMetricsA(dc, &metrics);
    GetTextFaceA(dc, LF_FACESIZE, face);
    SelectObject(dc, label_font);
    wsprintfA(line, "-%d %s w%d h%d ch%d il%d", request, face,
      metrics.tmAveCharWidth, metrics.tmHeight,
      metrics.tmHeight - metrics.tmInternalLeading, metrics.tmInternalLeading);
    text(dc, 8, y, line);
    SelectObject(dc, font);
    text(dc, 238, y, request >= 48 ? "AWVxy/\\" : "AWMWVxyz09/\\<>");
    SelectObject(dc, old);
    DeleteObject(font);
    y += metrics.tmHeight + 5;
  }
  SelectObject(dc, label_font);
  text(dc, 8, 424, "Press Space for stock-font ASCII tables");
}

static void ascii_block(HDC dc, int x, int y, int object, const char *label) {
  HFONT label_font = (HFONT)GetStockObject(SYSTEM_FONT);
  HFONT font = (HFONT)GetStockObject(object);
  HFONT old;
  TEXTMETRICA metrics;
  char face[LF_FACESIZE];
  char heading[96];
  char line[33];
  int row;
  int index;
  old = (HFONT)SelectObject(dc, font);
  GetTextMetricsA(dc, &metrics);
  GetTextFaceA(dc, LF_FACESIZE, face);
  SelectObject(dc, label_font);
  wsprintfA(heading, "%s -> %s %dx%d", label, face,
    metrics.tmAveCharWidth, metrics.tmHeight);
  text(dc, x, y, heading);
  SelectObject(dc, font);
  for (row = 0; row < 3; row++) {
    int count = 0;
    for (index = 0; index < 32; index++) {
      int code = 32 + row * 32 + index;
      if (code > 126) break;
      line[count++] = (char)code;
    }
    line[count] = 0;
    text(dc, x, y + 18 + row * metrics.tmHeight, line);
  }
  SelectObject(dc, old);
}

static void paint_stock_ascii(HDC dc) {
  text(dc, 8, 6, "Native Windows 98 stock-font printable ASCII");
  ascii_block(dc, 8, 28, SYSTEM_FIXED_FONT, "SYSTEM_FIXED");
  ascii_block(dc, 8, 155, OEM_FIXED_FONT, "OEM_FIXED");
  ascii_block(dc, 322, 28, ANSI_FIXED_FONT, "ANSI_FIXED");
  ascii_block(dc, 322, 155, SYSTEM_FONT, "SYSTEM_FONT");
  text(dc, 8, 424, "Press Space for installed-font inventory");
}

static LRESULT CALLBACK window_proc(HWND window, UINT message,
    WPARAM wparam, LPARAM lparam) {
  if (message == WM_KEYDOWN && wparam == VK_SPACE) {
    page = (page + 1) % 3;
    InvalidateRect(window, NULL, TRUE);
    return 0;
  }
  if (message == WM_LBUTTONDOWN) {
    page = (page + 1) % 3;
    InvalidateRect(window, NULL, TRUE);
    return 0;
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);
    SetBkMode(dc, OPAQUE);
    SetBkColor(dc, RGB(255, 255, 255));
    SetTextColor(dc, RGB(0, 0, 0));
    SelectObject(dc, GetStockObject(SYSTEM_FONT));
    if (page == 0) paint_inventory(dc);
    else if (page == 1) paint_sizes(dc);
    else paint_stock_ascii(dc);
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
  ZeroMemory(&cls, sizeof(cls));
  cls.style = CS_HREDRAW | CS_VREDRAW;
  cls.lpfnWndProc = window_proc;
  cls.hInstance = instance;
  cls.hCursor = LoadCursorA(NULL, IDC_ARROW);
  cls.hbrBackground = (HBRUSH)GetStockObject(WHITE_BRUSH);
  cls.lpszClassName = "FontInventoryReference";
  RegisterClassA(&cls);
  inventory_files();
  inventory_faces();
  window = CreateWindowA(cls.lpszClassName, "Windows 98 Bitmap Font Reference",
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE,
    0, 0, 640, 472, NULL, NULL, instance, NULL);
  ShowWindow(window, SW_SHOW);
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
