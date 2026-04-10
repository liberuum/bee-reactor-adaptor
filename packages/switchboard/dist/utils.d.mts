import { IReactorClient } from "@powerhousedao/reactor";
import { DriveInput } from "@powerhousedao/shared/document-drive";

//#region src/utils.d.mts
declare function addDefaultDrive(client: IReactorClient, drive: DriveInput, serverPort: number): Promise<string>;
declare function isPostgresUrl(url: string): boolean;
//#endregion
export { addDefaultDrive, isPostgresUrl };
//# sourceMappingURL=utils.d.mts.map