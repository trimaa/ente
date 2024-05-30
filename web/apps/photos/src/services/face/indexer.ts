import log from "@/next/log";
import { ComlinkWorker } from "@/next/worker/comlink-worker";
import { wait } from "@/utils/promise";
import { type Remote } from "comlink";
import mlIDbStorage from "services/face/db-old";
import machineLearningService, {
    defaultMLVersion,
} from "services/machineLearning/machineLearningService";
import mlWorkManager from "services/machineLearning/mlWorkManager";
import type { EnteFile } from "types/file";
import { indexableAndIndexedCounts, markIndexingFailed } from "./db";
import type { IndexStatus } from "./db-old";
import { indexFaces } from "./f-index";
import { FaceIndexerWorker } from "./indexer.worker";

/**
 * Face indexing orchestrator.
 *
 * This module exposes a singleton instance of this class which drives the face
 * indexing process on the user's library.
 *
 * The indexer operates in two modes - live indexing and backfill.
 *
 * When live indexing, any files that are being uploaded from the current client
 * are provided to the indexer, which puts them in a queue and indexes them one
 * by one. This is more efficient since we already have the file's content at
 * hand and do not have to download and decrypt it.
 *
 * When backfilling, the indexer figures out if any of the user's files
 * (irrespective of where they were uploaded from) still need to be indexed, and
 * if so, downloads, decrypts and indexes them.
 *
 * Live indexing has higher priority, backfilling runs otherwise. If nothing
 * remains to be indexed, the indexer goes to sleep for a while.
 */
class FaceIndexer {
    /** Live indexing queue. */
    private liveItems: { enteFile: EnteFile; file: File | undefined }[];
    /** Timeout for when the next time we will wake up. */
    private wakeTimeout: ReturnType<typeof setTimeout> | undefined;

    /**
     * Add a file to the live indexing queue.
     *
     * @param enteFile An {@link EnteFile} that should be indexed.
     *
     * @param file The contents of {@link enteFile} as a web {@link File}
     * object, if available.
     */
    enqueueFile(enteFile: EnteFile, file: File | undefined) {
        // If face indexing is not enabled, don't enqueue anything. Later on if
        // the user turns on face indexing these files will get indexed as part
        // of the backfilling anyway, the live indexing is just an optimization.
        if (!mlWorkManager.isMlSearchEnabled) return;

        this.liveItems.push({ enteFile, file });
        this.wakeUpIfNeeded();
    }

    private wakeUpIfNeeded() {
        // Already awake.
        if (!this.wakeTimeout) return;
        // Cancel the alarm, wake up now.
        clearTimeout(this.wakeTimeout);
        this.wakeTimeout = undefined;
        // Get to work.
        this.tick();
    }

    /**
     * A promise for the lazily created singleton {@link FaceIndexerWorker} remote
     * exposed by this module.
     */
    _faceIndexer: Promise<Remote<FaceIndexerWorker>>;
    /**
     * Main thread interface to the face indexer.
     *
     * This function provides a promise that resolves to a lazily created singleton
     * remote with a {@link FaceIndexerWorker} at the other end.
     */
    faceIndexer = (): Promise<Remote<FaceIndexerWorker>> =>
        (this._faceIndexer ??= createFaceIndexerComlinkWorker().remote);

    private async tick() {
        console.log("tick");

        const item = this.liveItems.pop();
        if (!item) {
            // TODO-ML: backfill instead if needed here.
            this.wakeTimeout = setTimeout(() => {
                this.wakeTimeout = undefined;
                this.wakeUpIfNeeded();
            }, 30 * 1000);
            return;
        }

        const fileID = item.enteFile.id;
        try {
            const faceIndex = await indexFaces(item.enteFile, item.file);
            log.info(`faces in file ${fileID}`, faceIndex);
        } catch (e) {
            log.error(`Failed to index faces in file ${fileID}`, e);
            markIndexingFailed(item.enteFile.id);
        }

        // Let the runloop drain.
        await wait(0);
        // Run again.
        this.tick();
    }

    /**
     * Add a newly uploaded file to the face indexing queue.
     *
     * @param enteFile The {@link EnteFile} that was uploaded.
     * @param file
     */
    /*
    indexFacesInFile = (enteFile: EnteFile, file: File) => {
        if (!mlWorkManager.isMlSearchEnabled) return;

        faceIndexer().then((indexer) => {
            indexer.enqueueFile(file, enteFile);
        });
    };
    */
}

/** The singleton instance of {@link FaceIndexer}. */
export default new FaceIndexer();

const createFaceIndexerComlinkWorker = () =>
    new ComlinkWorker<typeof FaceIndexerWorker>(
        "face-indexer",
        new Worker(new URL("indexer.worker.ts", import.meta.url)),
    );

export interface FaceIndexingStatus {
    /**
     * Which phase we are in within the indexing pipeline when viewed across the
     * user's entire library:
     *
     * - "scheduled": There are files we know of that have not been indexed.
     *
     * - "indexing": The face indexer is currently running.
     *
     * - "clustering": All files we know of have been indexed, and we are now
     *   clustering the faces that were found.
     *
     * - "done": Face indexing and clustering is complete for the user's
     *   library.
     */
    phase: "scheduled" | "indexing" | "clustering" | "done";
    /** The number of files that have already been indexed. */
    nSyncedFiles: number;
    /** The total number of files that are eligible for indexing. */
    nTotalFiles: number;
}

export const faceIndexingStatus = async (): Promise<FaceIndexingStatus> => {
    const isSyncing = machineLearningService.isSyncing;
    const { indexableCount, indexedCount } = await indexableAndIndexedCounts();

    let phase: FaceIndexingStatus["phase"];
    if (indexedCount < indexableCount) {
        if (!isSyncing) {
            phase = "scheduled";
        } else {
            phase = "indexing";
        }
    } else {
        phase = "done";
    }

    const indexingStatus = {
        phase,
        nTotalFiles: indexableCount,
        nSyncedFiles: indexedCount,
    };

    const indexStatus0 = await mlIDbStorage.getIndexStatus(defaultMLVersion);
    const indexStatus = convertToNewInterface(indexStatus0);

    log.debug(() => ({ indexStatus, indexingStatus }));

    return indexStatus;
};

const convertToNewInterface = (indexStatus: IndexStatus) => {
    let phase: FaceIndexingStatus["phase"];
    if (!indexStatus.localFilesSynced) {
        phase = "scheduled";
    } else if (indexStatus.outOfSyncFilesExists) {
        phase = "indexing";
    } else if (!indexStatus.peopleIndexSynced) {
        phase = "clustering";
    } else {
        phase = "done";
    }
    return {
        ...indexStatus,
        phase,
    };
};

/**
 * Return the IDs of all the faces in the given {@link enteFile} that are not
 * associated with a person cluster.
 */
export const unidentifiedFaceIDs = async (
    enteFile: EnteFile,
): Promise<{ id: string }[]> => {
    const mlFileData = await mlIDbStorage.getFile(enteFile.id);
    return mlFileData?.faces ?? [];
};
