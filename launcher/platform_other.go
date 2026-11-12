//go:build !windows

package main

import (
	"fmt"
	"os/exec"
	"runtime"
)

func hideWindow(cmd *exec.Cmd) {}
func openBrowser(url string) error {
	name, args := "xdg-open", []string{url}
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	return exec.Command(name, args...).Start()
}
func showError(msg string) { fmt.Println("Commodious GitDock:", msg) }
