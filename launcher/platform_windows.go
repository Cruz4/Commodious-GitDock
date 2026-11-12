//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func openBrowser(url string) error {
	cmd := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	hideWindow(cmd)
	return cmd.Start()
}
func showError(msg string) {
	title, _ := syscall.UTF16PtrFromString("Commodious GitDock")
	body, _ := syscall.UTF16PtrFromString(msg)
	proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	_, _, _ = proc.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x10)
}
