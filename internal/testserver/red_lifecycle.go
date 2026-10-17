// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

func (r *rtpRecorder) mediaReader() func() {
	r.mu.Lock()
	r.activeMediaReaders++
	r.mu.Unlock()

	return func() {
		r.mu.Lock()
		r.activeMediaReaders--
		r.mu.Unlock()
	}
}

func (r *rtpRecorder) sourceStarted() {
	r.mu.Lock()
	r.activeMediaWriters++
	r.mu.Unlock()
}

func (r *rtpRecorder) sourceFinished(completed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.activeMediaWriters--
	if completed {
		r.sourcesCompleted++
	}
	r.observation.SourceDone = r.sourcesCompleted == r.sourceTracks
}

func (r *rtpRecorder) mediaStopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.activeMediaReaders == 0 && r.activeMediaWriters == 0
}
