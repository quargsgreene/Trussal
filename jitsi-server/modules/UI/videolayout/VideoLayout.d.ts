declare const VideoLayout: {
    onLocalFlipXChanged(localFlipX: boolean): void;
    reset(): void;
    initLargeVideo(): void;
    setAudioLevel(id: string, lvl: number): void;
    updateVideoMutedForNoTracks(participantId: string): void;
    getRemoteVideoType(id: string): string | undefined;
    getPinnedId(): string | null;
    onLastNEndpointsChanged(
        endpointsLeavingLastN: string[] | null,
        endpointsEnteringLastN: string[] | null
    ): void;
    resizeVideoArea(): void;
    isLargeVideoVisible(): boolean;
    getCurrentlyOnLargeContainer(): any;
    isCurrentlyOnLarge(id: string): boolean;
    updateLargeVideo(
        id: string,
        forceUpdate?: boolean,
        forceStreamToReattach?: boolean
    ): void;
    addLargeVideoContainer(type: string, container: any): void;
    removeLargeVideoContainer(type: string): void;
    showLargeVideoContainer(type: string, show: boolean): Promise<void>;
    isLargeContainerTypeVisible(type: string): boolean;
    getLargeVideoID(): string | undefined;
    getLargeVideo(): any;
    getLargeVideoWrapper(): any;
    refreshLayout(): void;
    onResize(): void;
    _updateLargeVideoIfDisplayed(participantId: string, force?: boolean): void;
};

export default VideoLayout;

