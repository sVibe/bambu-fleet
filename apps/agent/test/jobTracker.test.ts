import { describe, expect, it } from "vitest";
import { JobTracker, type TrackedJob, type TrackerStore } from "../src/jobTracker.ts";

class MemoryStore implements TrackerStore {
  jobs = new Map<string, TrackedJob>();
  loadJob(serial: string) {
    return this.jobs.get(serial) ?? null;
  }
  saveJob(serial: string, job: TrackedJob | null) {
    if (job) this.jobs.set(serial, structuredClone(job));
    else this.jobs.delete(serial);
  }
}

function setup(store = new MemoryStore()) {
  let n = 0;
  const tracker = new JobTracker("SN1", store, () => `id${++n}`);
  return { tracker, store };
}

describe("JobTracker", () => {
  it("waits for a job name before announcing, then finishes", () => {
    const { tracker } = setup();
    expect(tracker.update({ gcode_state: "IDLE" }, [], 1000)).toEqual([]);
    expect(tracker.update({ gcode_state: "PREPARE", task_id: "77", subtask_name: "" }, [], 2000)).toEqual([]);

    const started = tracker.update(
      {
        gcode_state: "PREPARE",
        task_id: "77",
        subtask_id: "78",
        subtask_name: "Gears",
        total_layer_num: 120,
      },
      [],
      3000,
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.event).toMatchObject({
      type: "job.started",
      name: "Gears",
      taskId: "77",
      subtaskId: "78",
      startedAt: 2000,
      totalLayers: 120,
    });

    expect(tracker.update({ gcode_state: "RUNNING", task_id: "77", layer_num: 60 }, [], 4000)).toEqual([]);
    const ended = tracker.update(
      { gcode_state: "FINISH", task_id: "77", mc_percent: 100, layer_num: 120, total_layer_num: 120 },
      [],
      5000,
    );
    expect(ended.map((o) => o.event)).toEqual([
      expect.objectContaining({
        type: "job.ended",
        status: "finished",
        jobId: started[0]?.job.jobId,
        layer: 120,
      }),
    ]);
    expect(tracker.current).toBeNull();
    // Staying in FINISH doesn't produce more events.
    expect(tracker.update({ gcode_state: "FINISH" }, [], 6000)).toEqual([]);
  });

  it("separates cancellations from failures", () => {
    const { tracker } = setup();
    tracker.update({ gcode_state: "RUNNING", subtask_name: "A" }, [], 1);
    const cancelled = tracker.update({ gcode_state: "FAILED", print_error: 50348044 }, [], 2);
    expect(cancelled[0]?.event).toMatchObject({ status: "cancelled", printError: 50348044 });

    tracker.update({ gcode_state: "RUNNING", subtask_name: "B" }, [], 3);
    const failed = tracker.update({ gcode_state: "FAILED", print_error: 117473297, s_obj: [139] }, [], 4);
    expect(failed[0]?.event).toMatchObject({ status: "failed", skippedObjects: ["139"] });
  });

  it("treats IDLE after an active job as cancelled", () => {
    const { tracker } = setup();
    tracker.update({ gcode_state: "RUNNING", subtask_name: "C" }, [], 1);
    expect(tracker.update({ gcode_state: "IDLE" }, [], 2)[0]?.event).toMatchObject({ status: "cancelled" });
  });

  it("announces before ending a job that never got a name", () => {
    const { tracker } = setup();
    tracker.update({ gcode_state: "PREPARE", gcode_file: "/sdcard/Widget.gcode.3mf" }, [], 1);
    const out = tracker.update({ gcode_state: "FAILED", print_error: 50348044 }, [], 2);
    expect(out.map((o) => o.event.type)).toEqual(["job.started", "job.ended"]);
    expect(out[0]?.event).toMatchObject({ name: "Widget" });
  });

  it("starts a new job when the cloud task id changes mid-print", () => {
    const { tracker } = setup();
    tracker.update({ gcode_state: "RUNNING", task_id: "1", subtask_name: "One" }, [], 1);
    const out = tracker.update({ gcode_state: "PREPARE", task_id: "2", subtask_name: "Two" }, [], 2);
    expect(
      out.map((o) => [o.event.type, o.event.type === "job.ended" ? o.event.status : o.event.name]),
    ).toEqual([
      ["job.ended", "cancelled"],
      ["job.started", "Two"],
    ]);
  });

  it("keeps the job id across agent restarts", () => {
    const store = new MemoryStore();
    const first = setup(store).tracker;
    const [started] = first.update({ gcode_state: "RUNNING", subtask_name: "Long" }, [], 1);
    const second = new JobTracker("SN1", store, () => "new");
    const [ended] = second.update({ gcode_state: "FINISH" }, [], 2);
    expect(ended?.event).toMatchObject({ type: "job.ended", jobId: started?.job.jobId });
  });

  it("uses gcode_start_time when it is plausible", () => {
    const { tracker } = setup();
    const now = 1_760_000_000_000;
    const [out] = tracker.update(
      { gcode_state: "RUNNING", subtask_name: "X", gcode_start_time: "1759999000" },
      [],
      now,
    );
    expect(out?.event).toMatchObject({ startedAt: 1_759_999_000_000 });
  });
});
