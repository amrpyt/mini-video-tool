import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorSource } from "../app/editorReducer";
import { createDefaultCaptionStyle } from "../app/editorReducer";
import { Preview } from "./Preview";

afterEach(cleanup);

const youtubeSource: EditorSource = {
  kind: "youtube",
  url: "https://youtu.be/abc123",
  downloadQuality: "best",
  metadata: {
    videoId: "abc123",
    title: "Video title",
    duration: 100_000_000,
    thumbnailUrl: "https://example.test/poster.jpg",
    qualities: ["best", "p720"],
  },
};

const localSource: EditorSource = {
  kind: "local",
  path: "C:\Videos\clip.mp4",
  downloadQuality: "best",
  metadata: {
    duration: 100_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30_000, denominator: 1_001 },
    hasAudio: true,
  },
};

describe("Preview", () => {
  it("uses YouTube metadata/poster before download without requesting a frame", () => {
    const requestStillFrame = vi.fn();
    render(
      <Preview
        source={youtubeSource}
        playheadUs={0}
        requestStillFrame={requestStillFrame}
        toAssetUrl={(path) => path}
      />,
    );

    expect(screen.getByRole("img", { name: "معاينة فيديو يوتيوب" })).toHaveAttribute(
      "src",
      "https://example.test/poster.jpg",
    );
    expect(screen.getByText("Video title")).toBeInTheDocument();
    expect(requestStillFrame).not.toHaveBeenCalled();
  });

  it("renders native local video with a React overlay layer", () => {
    render(
      <Preview
        source={localSource}
        playheadUs={5_000_000}
        requestStillFrame={vi.fn()}
        toAssetUrl={() => "asset://clip.mp4"}
      />,
    );

    expect(screen.getByTestId("native-preview-video")).toHaveAttribute("src", "asset://clip.mp4");
    expect(screen.getByTestId("preview-overlay-layer")).toBeInTheDocument();
  });

  it("requests one lightweight still only after native playback fails", async () => {
    const requestStillFrame = vi.fn().mockResolvedValue("asset://preview.jpg");
    const { rerender } = render(
      <Preview
        source={localSource}
        playheadUs={5_000_000}
        requestStillFrame={requestStillFrame}
        toAssetUrl={() => "asset://clip.mp4"}
      />,
    );

    expect(requestStillFrame).not.toHaveBeenCalled();
    fireEvent.error(screen.getByTestId("native-preview-video"));
    await waitFor(() => expect(requestStillFrame).toHaveBeenCalledTimes(1));
    expect(requestStillFrame).toHaveBeenCalledWith(localSource.path, 5_000_000);
    expect(await screen.findByRole("img", { name: "إطار معاينة ثابت" })).toHaveAttribute(
      "src",
      "asset://preview.jpg",
    );

    rerender(
      <Preview
        source={localSource}
        playheadUs={8_000_000}
        requestStillFrame={requestStillFrame}
        toAssetUrl={() => "asset://clip.mp4"}
      />,
    );
    expect(requestStillFrame).toHaveBeenCalledTimes(1);
  });

  it("separates source-time edit visibility from physical local media seek time", async () => {
    const requestStillFrame = vi.fn().mockResolvedValue("asset://preview.jpg");
    render(
      <Preview
        source={localSource}
        playheadUs={12_000_000}
        mediaPlayheadUs={2_000_000}
        overlays={[
          {
            id: "source-time-overlay",
            kind: "blackBar",
            range: { start: 11_000_000, end: 13_000_000 },
            geometry: { x: 0, y: 0.8, width: 1, height: 0.2 },
            opacity: 1,
            assetPath: null,
            aspectLocked: false,
          },
        ]}
        requestStillFrame={requestStillFrame}
        toAssetUrl={() => "asset://clip.mp4"}
      />,
    );

    expect(screen.getByTestId("preview-overlay-source-time-overlay")).toBeInTheDocument();
    fireEvent.error(screen.getByTestId("native-preview-video"));
    await waitFor(() => expect(requestStillFrame).toHaveBeenCalledWith(localSource.path, 2_000_000));
  });

  it("uses Space for native play/pause but ignores Space while typing", () => {
    render(
      <>
        <input aria-label="حقل كتابة" />
        <Preview source={localSource} playheadUs={0} toAssetUrl={() => "asset://clip.mp4"} />
      </>,
    );
    const video = screen.getByTestId("native-preview-video") as HTMLVideoElement;
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    Object.defineProperty(video, "play", { value: play });
    Object.defineProperty(video, "pause", { value: pause });
    Object.defineProperty(video, "paused", { value: true, configurable: true });

    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    expect(play).toHaveBeenCalledTimes(1);

    const input = screen.getByRole("textbox", { name: "حقل كتابة" });
    input.focus();
    fireEvent.keyDown(input, { code: "Space", key: " " });
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("gives the icon-only resize control an accessible name", () => {
    render(
      <Preview
        source={localSource}
        playheadUs={1_000_000}
        overlays={[
          {
            id: "overlay-accessible",
            kind: "blackBar",
            range: { start: 0, end: 2_000_000 },
            geometry: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
            opacity: 1,
            assetPath: null,
            aspectLocked: false,
          },
        ]}
        selectedOverlayId="overlay-accessible"
        onOverlayGeometryChange={vi.fn()}
        toAssetUrl={() => "asset://clip.mp4"}
      />,
    );

    expect(screen.getByRole("button", { name: "تغيير حجم العنصر" })).toBeInTheDocument();
  });

  it("keeps caption left/right physical and measures vertical margin from frame height", () => {
    const style = {
      ...createDefaultCaptionStyle(),
      horizontalPosition: "left" as const,
      verticalPosition: "bottom" as const,
      marginPercent: 7,
    };
    render(
      <Preview
        source={localSource}
        playheadUs={5_000_000}
        captionTrack={{
          enabled: true,
          cues: [{ start: 0, end: 10_000_000, text: "نص caption" }],
          style,
        }}
        requestStillFrame={vi.fn()}
        toAssetUrl={() => "asset://clip.mp4"}
      />,
    );

    const layer = screen.getByTestId("preview-caption-layer");
    expect(layer).toHaveClass("caption-left", "caption-bottom");
    expect(layer).toHaveStyle({ direction: "ltr", paddingBottom: "7cqh" });
    expect(screen.getByText("نص caption").closest('[dir="auto"]')).not.toBeNull();
  });
});
