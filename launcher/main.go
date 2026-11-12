// Commodious GitDock one-file Windows installer and launcher.
// Copyright (c) 2026 Commodious Works LLC. Created by Jordie Cruz.
// This program uses only the Go standard library and embeds the GitDock app.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed assets/server.js assets/zip.js assets/linked-projects.js assets/package.json assets/GitDock.ico assets/public/*
var appFiles embed.FS

const (
	appVersion = "1.2.0"
	appFolder  = "Commodious Works"
	appTitle   = "Commodious GitDock"
)

type prerequisite struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Package string `json:"-"`
	Link    string `json:"link"`
	Found   bool   `json:"found"`
}

var requirements = []prerequisite{
	{Key: "node", Name: "Node.js", Package: "OpenJS.NodeJS.LTS", Link: "https://nodejs.org/en/download"},
	{Key: "git", Name: "Git", Package: "Git.Git", Link: "https://git-scm.com/downloads/win"},
	{Key: "gh", Name: "GitHub CLI", Package: "GitHub.cli", Link: "https://cli.github.com/"},
}

type setupStatus struct {
	Version string         `json:"version"`
	Phase   string         `json:"phase"`
	Detail  string         `json:"detail"`
	Error   string         `json:"error,omitempty"`
	Ready   string         `json:"ready,omitempty"`
	Tools   []prerequisite `json:"tools"`
}

type setup struct {
	mu      sync.Mutex
	running bool
	status  setupStatus
	appDir  string
	done    chan struct{}
}

func userAppDir() (string, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		local = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(local, appFolder, "GitDock"), nil
}

func installAppFiles(appDir string) error {
	return fs.WalkDir(appFiles, "assets", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(name, "assets/")
		// Only fixed, embedded files can be installed. No downloads or user paths.
		target := filepath.Join(appDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		data, err := appFiles.ReadFile(name)
		if err != nil {
			return err
		}
		tmp := target + ".install-tmp"
		if err := os.WriteFile(tmp, data, 0644); err != nil {
			return err
		}
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("update %s: %w", rel, err)
		}
		return nil
	})
}

func copyExecutable(appDir string) (string, error) {
	current, err := os.Executable()
	if err != nil {
		return "", err
	}
	target := filepath.Join(appDir, "GitDock.exe")
	a, _ := filepath.Abs(current)
	b, _ := filepath.Abs(target)
	if strings.EqualFold(a, b) {
		return target, nil
	}
	in, err := os.Open(current)
	if err != nil {
		return "", err
	}
	defer in.Close()
	tmp := target + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if _, err = io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return "", err
	}
	if err = out.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	// On Windows, the previous installed executable may still be active.
	// In that case do not prevent the app from launching.
	if err = os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		if _, statErr := os.Stat(target); statErr != nil {
			return "", err
		}
	}
	return target, nil
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func makeShortcuts(appDir, launcher string) error {
	ico := filepath.Join(appDir, "GitDock.ico")
	// WScript.Shell is included with Windows; shortcuts require no third-party installer.
	script := `$ErrorActionPreference = 'Stop'` + "\n" +
		`$exe = ` + psQuote(launcher) + "\n" +
		`$ico = ` + psQuote(ico) + "\n" +
		`$wd = ` + psQuote(appDir) + "\n" +
		`$shell = New-Object -ComObject WScript.Shell` + "\n" +
		`$menu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Commodious Works'` + "\n" +
		`New-Item -ItemType Directory -Force -Path $menu | Out-Null` + "\n" +
		`$places = @((Join-Path $menu 'Commodious GitDock.lnk'), (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Commodious GitDock.lnk'))` + "\n" +
		`foreach ($place in $places) { $s = $shell.CreateShortcut($place); $s.TargetPath = $exe; $s.WorkingDirectory = $wd; $s.IconLocation = $ico; $s.Description = 'GitDock - Drop it. Ship it. By Commodious Works LLC'; $s.Save() }` + "\n"
	file := filepath.Join(appDir, "shortcuts.ps1")
	if err := os.WriteFile(file, []byte(script), 0600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file)
	hideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("shortcuts: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func toolCandidates(key string) []string {
	programFiles := os.Getenv("ProgramFiles")
	programX86 := os.Getenv("ProgramFiles(x86)")
	local := os.Getenv("LOCALAPPDATA")
	windows := os.Getenv("WINDIR")
	var suffixes []string
	switch key {
	case "node":
		suffixes = []string{"nodejs/node.exe", "Programs/nodejs/node.exe"}
	case "git":
		suffixes = []string{"Git/cmd/git.exe", "Git/bin/git.exe", "Programs/Git/cmd/git.exe"}
	case "gh":
		suffixes = []string{"GitHub CLI/gh.exe", "Programs/GitHub CLI/gh.exe", "Microsoft/WinGet/Links/gh.exe"}
	case "winget":
		suffixes = []string{"Microsoft/WindowsApps/winget.exe"}
	}
	dirs := []string{programFiles, programX86, local, windows}
	candidates := []string{}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, suffix := range suffixes {
			candidates = append(candidates, filepath.Join(dir, filepath.FromSlash(suffix)))
		}
	}
	return candidates
}

func findTool(key string) string {
	name := key + ".exe"
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, p := range toolCandidates(key) {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func checkTools() []prerequisite {
	found := make([]prerequisite, len(requirements))
	for i, req := range requirements {
		found[i] = req
		found[i].Found = findTool(req.Key) != ""
	}
	return found
}
func allToolsReady(tools []prerequisite) bool {
	for _, item := range tools {
		if !item.Found {
			return false
		}
	}
	return true
}
func missingSummary(tools []prerequisite) string {
	missing := []string{}
	for _, item := range tools {
		if !item.Found {
			missing = append(missing, item.Name)
		}
	}
	return strings.Join(missing, ", ")
}

func readPort(appDir string) string {
	raw, err := os.ReadFile(filepath.Join(appDir, "server-port.txt"))
	if err != nil {
		return ""
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || port < 1024 || port > 65535 {
		return ""
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := http.Client{Timeout: 1400 * time.Millisecond}
	response, err := client.Get(url + "/")
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 500))
	if err != nil || !strings.Contains(string(body), "Commodious GitDock") {
		return ""
	}
	// An older GitDock instance may still be running after an upgrade.
	// Never mistake its old UI for the currently installed version.
	versionResp, err := client.Get(url + "/api/version")
	if err != nil {
		return ""
	}
	defer versionResp.Body.Close()
	var current struct {
		Version string `json:"version"`
	}
	if versionResp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(versionResp.Body, 500)).Decode(&current) != nil || current.Version != appVersion {
		return ""
	}
	return url
}

func reservePort() (int, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port, nil
}

func startApplication(appDir string) (string, error) {
	if current := readPort(appDir); current != "" {
		return current, nil
	}
	node := findTool("node")
	git := findTool("git")
	gh := findTool("gh")
	if node == "" || git == "" || gh == "" {
		return "", errors.New("Required tools are missing")
	}
	port, err := reservePort()
	if err != nil {
		return "", err
	}
	logPath := filepath.Join(appDir, "server.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	defer logFile.Close()
	cmd := exec.Command(node, filepath.Join(appDir, "server.js"))
	cmd.Dir = appDir
	// winget updates the registry PATH, but running installer processes may have
	// the old environment. Pass the resolved Git/gh directories explicitly.
	envPath := strings.Join([]string{filepath.Dir(node), filepath.Dir(git), filepath.Dir(gh), os.Getenv("PATH")}, string(os.PathListSeparator))
	cmd.Env = append(os.Environ(), "PATH="+envPath, fmt.Sprintf("GITDOCK_PORT=%d", port), "GITDOCK_NO_BROWSER=1")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(18 * time.Second)
	client := &http.Client{Timeout: 900 * time.Millisecond}
	for time.Now().Before(deadline) {
		response, getErr := client.Get(url + "/")
		if getErr == nil {
			data, _ := io.ReadAll(io.LimitReader(response.Body, 600))
			_ = response.Body.Close()
			if response.StatusCode == 200 && strings.Contains(string(data), "Commodious GitDock") {
				_ = os.WriteFile(filepath.Join(appDir, "server-port.txt"), []byte(strconv.Itoa(port)), 0600)
				return url, nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return "", fmt.Errorf("GitDock did not start (PID %d). See %s", pid, logPath)
}

func (s *setup) update(phase, detail, problem, ready string) {
	s.mu.Lock()
	s.status.Phase, s.status.Detail, s.status.Error, s.status.Ready = phase, detail, problem, ready
	s.status.Tools = checkTools()
	s.mu.Unlock()
}
func (s *setup) snapshot() setupStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	copyStatus := s.status
	copyStatus.Tools = append([]prerequisite(nil), s.status.Tools...)
	return copyStatus
}

func (s *setup) run() {
	defer func() { s.mu.Lock(); s.running = false; s.mu.Unlock() }()
	tools := checkTools()
	if !allToolsReady(tools) {
		winget := findTool("winget")
		if winget == "" {
			s.update("needs-help", "Windows Package Manager (winget) is not available.", "Install missing tools using the official links below, then click Retry.", "")
			return
		}
		for _, req := range requirements {
			if findTool(req.Key) != "" {
				continue
			}
			s.update("installing", "Installing "+req.Name+" using Windows Package Manager. Windows may ask you to approve installation.", "", "")
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
			cmd := exec.CommandContext(ctx, winget, "install", "--id", req.Package, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements")
			hideWindow(cmd)
			output, err := cmd.CombinedOutput()
			cancel()
			if err != nil && findTool(req.Key) == "" {
				detail := strings.TrimSpace(string(output))
				if len(detail) > 500 {
					detail = detail[len(detail)-500:]
				}
				s.update("needs-help", "Could not install "+req.Name+" automatically.", fmt.Sprintf("%s: %v. %s", req.Name, err, detail), "")
				return
			}
		}
	}
	tools = checkTools()
	if !allToolsReady(tools) {
		s.update("needs-help", "Install the remaining tools and click Retry.", "Missing: "+missingSummary(tools), "")
		return
	}
	s.update("launching", "All tools are ready. Opening GitDock…", "", "")
	url, err := startApplication(s.appDir)
	if err != nil {
		s.update("needs-help", "GitDock could not start.", err.Error(), "")
		return
	}
	s.update("ready", "GitDock is running. Opening your workspace…", "", url)
	select {
	case s.done <- struct{}{}:
	default:
	}
}

func (s *setup) tryStart() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.mu.Unlock()
	go s.run()
}

func serveSetup(s *setup) (string, func(), error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	session := strconv.FormatInt(time.Now().UnixNano(), 36)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, strings.ReplaceAll(setupHTML, "SETUP_SESSION_TOKEN", session))
	})
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(s.snapshot())
	})
	mux.HandleFunc("/api/retry", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-Setup-Token") != session {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		s.tryStart()
		w.WriteHeader(http.StatusAccepted)
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(listener) }()
	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}
	return fmt.Sprintf("http://127.0.0.1:%d/", port), stop, nil
}

func main() {
	appDir, err := userAppDir()
	if err != nil {
		showError("GitDock could not locate your user folder: " + err.Error())
		return
	}
	if err := os.MkdirAll(appDir, 0755); err != nil {
		showError("GitDock could not create its folder: " + err.Error())
		return
	}
	if err := installAppFiles(appDir); err != nil {
		showError("GitDock could not install its files: " + err.Error())
		return
	}
	installed, err := copyExecutable(appDir)
	if err != nil {
		showError("GitDock could not install the launcher: " + err.Error())
		return
	}
	// Shortcut creation failure is not fatal; launching the EXE still works.
	_ = makeShortcuts(appDir, installed)
	if current := readPort(appDir); current != "" {
		_ = openBrowser(current)
		return
	}
	if allToolsReady(checkTools()) {
		if url, err := startApplication(appDir); err == nil {
			_ = openBrowser(url)
			return
		}
	}
	s := &setup{appDir: appDir, done: make(chan struct{}, 1)}
	s.status = setupStatus{Version: appVersion, Phase: "checking", Detail: "Checking what GitDock needs to run…", Tools: checkTools()}
	ui, stop, err := serveSetup(s)
	if err != nil {
		showError("GitDock could not start the setup page: " + err.Error())
		return
	}
	defer stop()
	_ = openBrowser(ui)
	s.tryStart()
	select {
	case <-s.done:
		time.Sleep(30 * time.Second) // give the setup page time to redirect
	case <-time.After(30 * time.Minute):
	}
}
