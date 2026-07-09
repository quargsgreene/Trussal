class ParticpantAVBufferQueue {
  constructor(maxBuffersPerParticipant = 8) {
    this.maxBuffers = maxBuffersPerParticipant;
    this._items = [];
  }

  async writeToParticipantRingBuffer(entry) {
    // writes next buffer in queue to wring buffer, and evicts oldest buffer if queue is full
    // if full, makes sure reads are happening
    // if it is not the participant's turn to write, waits until it is
  }

  async enqueueBuffers(buffers) {
    // adds buffers to the queue, and evicts oldest buffers if queue is full
    // if full, makes sure reads are happening
    // if not the participant's turn to write, waits until it is
  }

  async dequeueBuffers() {
    // returns the next buffer in the queue, or null if the queue is empty
    // if empty, makes sure writes are happening
  }
}