import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorSource } from "../app/editorReducer";
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
});
