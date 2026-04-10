import { driveCreateDocument, driveCreateState } from "@powerhousedao/shared/document-drive";
import "@powerhousedao/shared/document-model";
//#region src/utils.mts
async function addDefaultDrive(client, drive, serverPort) {
	let driveId = drive.id;
	if (!driveId || driveId.length === 0) driveId = drive.slug;
	if (!driveId || driveId.length === 0) throw new Error("Invalid Drive Id");
	let existingDrive;
	try {
		existingDrive = await client.get(driveId);
	} catch {}
	if (existingDrive) return `http://localhost:${serverPort}/d/${driveId}`;
	const { global } = driveCreateState();
	const document = driveCreateDocument({
		global: {
			...global,
			name: drive.global.name,
			icon: drive.global.icon ?? global.icon
		},
		local: {
			availableOffline: drive.local?.availableOffline ?? false,
			sharingType: drive.local?.sharingType ?? "public",
			listeners: drive.local?.listeners ?? [],
			triggers: drive.local?.triggers ?? []
		}
	});
	if (drive.id && drive.id.length > 0) document.header.id = drive.id;
	if (drive.slug && drive.slug.length > 0) document.header.slug = drive.slug;
	if (drive.global.name) document.header.name = drive.global.name;
	if (drive.preferredEditor) document.header.meta = { preferredEditor: drive.preferredEditor };
	try {
		await client.create(document);
	} catch (e) {
		if (!(e instanceof Error ? e.message : String(e)).includes("already exists")) throw e;
	}
	return `http://localhost:${serverPort}/d/${driveId}`;
}
function isPostgresUrl(url) {
	return url.startsWith("postgresql") || url.startsWith("postgres");
}
//#endregion
export { isPostgresUrl as n, addDefaultDrive as t };

//# sourceMappingURL=utils-DFl0ezBT.mjs.map