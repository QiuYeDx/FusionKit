/*
 * Resolve the delayed Node import against the current host executable.
 * Electron Builder renames electron.exe, so loading node.exe by name would
 * either fail or bind the addon to an unrelated system Node installation.
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <delayimp.h>
#include <string.h>

#ifndef HOST_BINARY
#error HOST_BINARY must name the delayed Node host import.
#endif

static FARPROC WINAPI LoadHostExecutable(
    unsigned int event,
    DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary || info == nullptr ||
      _stricmp(info->szDll, HOST_BINARY) != 0) {
    return nullptr;
  }

  HMODULE host = GetModuleHandleW(L"libnode.dll");
  if (host == nullptr) host = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(host);
}

extern "C" PfnDliHook __pfnDliNotifyHook2 = LoadHostExecutable;
