#include <windows.h>

/*
 * Local-only extraction helper. It copies selected font files from a user's
 * Win98 VM through COM1. No Microsoft font bytes belong in the repository.
 */

unsigned long _tls_index = 0;
static HANDLE serial;

static void write_all(HANDLE handle, const void *data, DWORD size) {
  const unsigned char *bytes = (const unsigned char *)data;
  while (size) {
    DWORD written = 0;
    DWORD chunk = size > 4096 ? 4096 : size;
    if (!WriteFile(handle, bytes, chunk, &written, NULL) || !written) return;
    bytes += written;
    size -= written;
  }
}

static void emit_file(const char *path, const char *name) {
  HANDLE file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  char header[96];
  unsigned char buffer[4096];
  DWORD size;
  DWORD read;
  int length;
  if (file == INVALID_HANDLE_VALUE) {
    length = wsprintfA(header, "MISSING %s\r\n", name);
    write_all(serial, header, (DWORD)length);
    return;
  }
  size = GetFileSize(file, NULL);
  length = wsprintfA(header, "FILE %s %lu\r\n", name, size);
  write_all(serial, header, (DWORD)length);
  while (ReadFile(file, buffer, sizeof(buffer), &read, NULL) && read)
    write_all(serial, buffer, read);
  CloseHandle(file);
  write_all(serial, "\r\nEND_FILE\r\n", 12);
}

void WINAPI WinMainCRTStartup(void) {
  serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  if (serial != INVALID_HANDLE_VALUE) {
    write_all(serial, "FONT_FILE_DUMP_V1\r\n", 19);
    emit_file("C:\\WINDOWS\\FONTS\\ARIAL.TTF", "ARIAL.TTF");
    emit_file("C:\\WINDOWS\\FONTS\\TIMES.TTF", "TIMES.TTF");
    emit_file("C:\\WINDOWS\\FONTS\\COUR.TTF", "COUR.TTF");
    emit_file("C:\\WINDOWS\\FONTS\\SSERIFE.FON", "SSERIFE.FON");
    write_all(serial, "FONT_FILE_DUMP_DONE\r\n", 21);
    CloseHandle(serial);
  }
  ExitProcess(0);
}
