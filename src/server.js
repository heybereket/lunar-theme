'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const minimatch = require("minimatch");
const server = require("vscode-languageserver");
const protocol_configuration_proposed_1 = require("vscode-languageserver-protocol/lib/protocol.configuration.proposed");
const path = require("path");
const semver = require("semver");
const vscode_uri_1 = require("vscode-uri");
const util = require("util");
const delayer_1 = require("./delayer");
const fixer_1 = require("./fixer");
class ConfigCache {
    constructor() {
        this.filePath = undefined;
        this.configuration = undefined;
    }
    set(path, configuration) {
        this.filePath = path;
        this.configuration = configuration;
    }
    get(forPath) {
        if (forPath === this.filePath) {
            return this.configuration;
        }
        return undefined;
    }
    isDefaultLinterConfig() {
        if (this.configuration) {
            return this.configuration.isDefaultLinterConfig;
        }
        return false;
    }
    flush() {
        this.filePath = undefined;
        this.configuration = undefined;
    }
}
class SettingsCache {
    constructor() {
        this.uri = undefined;
        this.settings = undefined;
    }
    get(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            if (uri === this.uri) {
                return this.settings;
            }
            if (scopedSettingsSupport) {
                let configRequestParam = { items: [{ scopeUri: uri, section: 'tslint' }] };
                let settings = yield connection.sendRequest(protocol_configuration_proposed_1.ConfigurationRequest.type, configRequestParam);
                this.settings = settings[0];
                resolveGlobalPackageManagerPath(this.settings);
                this.uri = uri;
                return this.settings;
            }
            return globalSettings;
        });
    }
    flush() {
        this.uri = undefined;
        this.settings = undefined;
    }
}
let configCache = new ConfigCache();
let settingsCache = new SettingsCache();
let globalSettings = {};
let scopedSettingsSupport = false;
class ID {
    static next() {
        return `${ID.base}${ID.counter++}`;
    }
}
ID.base = `${Date.now().toString()}-`;
ID.counter = 0;
function computeKey(diagnostic) {
    let range = diagnostic.range;
    return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
}
var Status;
(function (Status) {
    Status[Status["ok"] = 1] = "ok";
    Status[Status["warn"] = 2] = "warn";
    Status[Status["error"] = 3] = "error";
})(Status || (Status = {}));
var StatusNotification;
(function (StatusNotification) {
    StatusNotification.type = new server.NotificationType('tslint/status');
})(StatusNotification || (StatusNotification = {}));
var NoTSLintLibraryRequest;
(function (NoTSLintLibraryRequest) {
    NoTSLintLibraryRequest.type = new server.RequestType('tslint/noLibrary');
})(NoTSLintLibraryRequest || (NoTSLintLibraryRequest = {}));
// if tslint < tslint4 then the linter is the module therefore the type `any`
let path2Library = new Map();
let document2Library = new Map();
let validationDelayer = new Map(); // key is the URI of the document
let configFileWatchers = new Map();
function makeDiagnostic(settings, problem) {
    let message = (problem.getRuleName())
        ? `${problem.getFailure()} (${problem.getRuleName()})`
        : `${problem.getFailure()}`;
    let severity;
    let alwaysWarning = settings && settings.alwaysShowRuleFailuresAsWarnings;
    // tslint5 supports to assign severities to rules
    if (!alwaysWarning && problem.getRuleSeverity && problem.getRuleSeverity() === 'error') {
        severity = server.DiagnosticSeverity.Error;
    }
    else {
        severity = server.DiagnosticSeverity.Warning;
    }
    let diagnostic = {
        severity: severity,
        message: message,
        range: {
            start: {
                line: problem.getStartPosition().getLineAndCharacter().line,
                character: problem.getStartPosition().getLineAndCharacter().character
            },
            end: {
                line: problem.getEndPosition().getLineAndCharacter().line,
                character: problem.getEndPosition().getLineAndCharacter().character
            },
        },
        code: problem.getRuleName(),
        source: 'tslint'
    };
    return diagnostic;
}
let codeFixActions = new Map();
let codeDisableRuleActions = new Map();
function recordCodeAction(document, diagnostic, problem) {
    let documentDisableRuleFixes = codeDisableRuleActions[document.uri];
    if (!documentDisableRuleFixes) {
        documentDisableRuleFixes = Object.create(null);
        codeDisableRuleActions[document.uri] = documentDisableRuleFixes;
    }
    documentDisableRuleFixes[computeKey(diagnostic)] = createDisableRuleFix(problem, document);
    let fix = undefined;
    // tslint can return a fix with an empty replacements array, these fixes are ignored
    if (problem.getFix && problem.getFix() && !replacementsAreEmpty(problem.getFix())) {
        fix = createAutoFix(problem, document, problem.getFix());
    }
    if (!fix) {
        let vscFix = fixer_1.createVscFixForRuleFailure(problem, document);
        if (vscFix) {
            fix = createAutoFix(problem, document, vscFix);
        }
    }
    if (!fix) {
        return;
    }
    let documentAutoFixes = codeFixActions[document.uri];
    if (!documentAutoFixes) {
        documentAutoFixes = Object.create(null);
        codeFixActions[document.uri] = documentAutoFixes;
    }
    documentAutoFixes[computeKey(diagnostic)] = fix;
}
function convertReplacementToAutoFix(document, repl) {
    let start = document.positionAt(repl.start);
    let end = document.positionAt(repl.end);
    return {
        range: [start, end],
        text: repl.text,
    };
}
function getConfiguration(uri, filePath, library, configFileName) {
    return __awaiter(this, void 0, void 0, function* () {
        let config = configCache.get(filePath);
        if (config) {
            return config;
        }
        let isDefaultConfig = false;
        let linterConfiguration;
        let linter = getLinterFromLibrary(library);
        if (isTsLintVersion4(library)) {
            if (linter.findConfigurationPath) {
                isDefaultConfig = linter.findConfigurationPath(configFileName, filePath) === undefined;
            }
            let configurationResult = linter.findConfiguration(configFileName, filePath);
            // between tslint 4.0.1 and tslint 4.0.2 the attribute 'error' has been removed from IConfigurationLoadResult
            // in 4.0.2 findConfiguration throws an exception as in version ^3.0.0
            if (configurationResult.error) {
                throw configurationResult.error;
            }
            linterConfiguration = configurationResult.results;
        }
        else {
            // prior to tslint 4.0 the findconfiguration functions where attached to the linter function
            if (linter.findConfigurationPath) {
                isDefaultConfig = linter.findConfigurationPath(configFileName, filePath) === undefined;
            }
            linterConfiguration = linter.findConfiguration(configFileName, filePath);
        }
        let configuration = {
            isDefaultLinterConfig: isDefaultConfig,
            linterConfiguration: linterConfiguration,
        };
        configCache.set(filePath, configuration);
        return configCache.configuration;
    });
}
function getErrorMessage(err, document) {
    let errorMessage = `unknown error`;
    if (typeof err.message === 'string' || err.message instanceof String) {
        errorMessage = err.message;
    }
    let fsPath = server.Files.uriToFilePath(document.uri);
    let message = `vscode-tslint: '${errorMessage}' while validating: ${fsPath} stacktrace: ${err.stack}`;
    return message;
}
function getConfigurationFailureMessage(err) {
    let errorMessage = `unknown error`;
    if (typeof err.message === 'string' || err.message instanceof String) {
        errorMessage = err.message;
    }
    return `vscode-tslint: Cannot read tslint configuration - '${errorMessage}'`;
}
function showConfigurationFailure(conn, err) {
    conn.console.info(getConfigurationFailureMessage(err));
    conn.sendNotification(StatusNotification.type, { state: Status.error });
}
function validateAllTextDocuments(conn, documents) {
    let tracker = new server.ErrorMessageTracker();
    documents.forEach(document => {
        try {
            validateTextDocument(conn, document);
        }
        catch (err) {
            tracker.add(getErrorMessage(err, document));
        }
    });
}
function getLinterFromLibrary(library) {
    let isTsLint4 = isTsLintVersion4(library);
    let linter;
    if (!isTsLint4) {
        linter = library;
    }
    else {
        linter = library.Linter;
    }
    return linter;
}
function validateTextDocument(connection, document) {
    return __awaiter(this, void 0, void 0, function* () {
        let uri = document.uri;
        // tslint can only validate files on disk
        if (vscode_uri_1.default.parse(uri).scheme !== 'file') {
            return;
        }
        let settings = yield settingsCache.get(uri);
        if (settings && !settings.enable) {
            return;
        }
        if (!document2Library.has(document.uri)) {
            yield loadLibrary(document.uri);
        }
        if (!document2Library.has(document.uri)) {
            return;
        }
        document2Library.get(document.uri).then((library) => __awaiter(this, void 0, void 0, function* () {
            if (!library) {
                return;
            }
            try {
                let diagnostics = yield doValidate(connection, library, document);
                connection.sendDiagnostics({ uri, diagnostics });
            }
            catch (err) {
                connection.window.showErrorMessage(getErrorMessage(err, document));
            }
        }));
    });
}
let connection = server.createConnection(new server.IPCMessageReader(process), new server.IPCMessageWriter(process));
let documents = new server.TextDocuments();
documents.listen(connection);
function trace(message, verbose) {
    connection.tracer.log(message, verbose);
}
connection.onInitialize((params) => {
    function hasClientCapability(name) {
        let keys = name.split('.');
        let c = params.capabilities;
        for (let i = 0; c && i < keys.length; i++) {
            c = c[keys[i]];
        }
        return !!c;
    }
    scopedSettingsSupport = hasClientCapability('workspace.configuration');
    //globalNodePath = server.Files.resolveGlobalNodePath();
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            codeActionProvider: true
        }
    };
});
function isTsLintVersion4(library) {
    let version = '1.0.0';
    try {
        version = library.Linter.VERSION;
    }
    catch (e) {
    }
    return !(semver.satisfies(version, "<= 3.x.x"));
}
function loadLibrary(docUri) {
    return __awaiter(this, void 0, void 0, function* () {
        let uri = vscode_uri_1.default.parse(docUri);
        let promise;
        let settings = yield settingsCache.get(docUri);
        let resolvedGlobalPath = undefined;
        if (settings) {
            resolvedGlobalPath = settings.resolvedGlobalPackageManagerPath;
        }
        if (uri.scheme === 'file') {
            let file = uri.fsPath;
            let directory = path.dirname(file);
            if (settings && settings.nodePath) {
                promise = server.Files.resolve('tslint', settings.nodePath, settings.nodePath, trace).then(undefined, () => {
                    return server.Files.resolve('tslint', resolvedGlobalPath, directory, trace);
                });
            }
            else {
                promise = server.Files.resolve('tslint', resolvedGlobalPath, directory, trace);
            }
        }
        else {
            promise = server.Files.resolve('tslint', resolvedGlobalPath, undefined, trace); // cwd argument can be  undefined
        }
        document2Library.set(docUri, promise.then((path) => {
            let library;
            if (!path2Library.has(path)) {
                library = require(path);
                connection.console.info(`TSLint library loaded from: ${path} using ${settings.resolvedGlobalPackageManagerPath}`);
                path2Library.set(path, library);
            }
            return path2Library.get(path);
        }, () => {
            connection.sendRequest(NoTSLintLibraryRequest.type, { source: { uri: docUri } });
            return undefined;
        }));
    });
}
function doValidate(conn, library, document) {
    return __awaiter(this, void 0, void 0, function* () {
        let uri = document.uri;
        let diagnostics = [];
        delete codeFixActions[uri];
        delete codeDisableRuleActions[uri];
        let fsPath = server.Files.uriToFilePath(uri);
        if (!fsPath) {
            // tslint can only lint files on disk
            trace(`No linting: file is not saved on disk`);
            return diagnostics;
        }
        let settings = yield settingsCache.get(uri);
        if (!settings) {
            trace('No linting: settings could not be loaded');
            return diagnostics;
        }
        if (fileIsExcluded(settings, fsPath)) {
            trace(`No linting: file ${fsPath} is excluded`);
            return diagnostics;
        }
        let contents = document.getText();
        let configFile = settings.configFile || null;
        let configuration;
        try {
            configuration = yield getConfiguration(uri, fsPath, library, configFile);
        }
        catch (err) {
            // this should not happen since we guard against incorrect configurations
            showConfigurationFailure(conn, err);
            trace(`No linting: exception when getting tslint configuration for ${fsPath}, configFile= ${configFile}`);
            return diagnostics;
        }
        if (!configuration) {
            trace(`No linting: no tslint configuration`);
            return diagnostics;
        }
        if (isJsDocument(document) && !settings.jsEnable) {
            trace(`No linting: a JS document, but js linting is disabled`);
            return diagnostics;
        }
        if (settings.validateWithDefaultConfig === false && configCache.configuration.isDefaultLinterConfig) {
            trace(`No linting: linting with default tslint configuration is disabled`);
            return diagnostics;
        }
        let result;
        let options = {
            formatter: "json",
            fix: false,
            rulesDirectory: settings.rulesDirectory || undefined,
            formattersDirectory: undefined
        };
        if (settings.trace && settings.trace.server === 'verbose') {
            traceConfigurationFile(configuration.linterConfiguration);
        }
        try {
            let linter = getLinterFromLibrary(library);
            if (isTsLintVersion4(library)) {
                let tslint = new linter(options);
                trace(`Linting: start linting with tslint > version 4`);
                tslint.lint(fsPath, contents, configuration.linterConfiguration);
                result = tslint.getResult();
                trace(`Linting: ended linting`);
            }
            else if (!isJsDocument(document)) {
                options.configuration = configuration.linterConfiguration;
                trace(`Linting: with tslint < version 4`);
                let tslint = new linter(fsPath, contents, options);
                result = tslint.lint();
                trace(`Linting: ended linting`);
            }
            else {
                trace(`No linting: JS linting not supported in tslint < version 4`);
                return diagnostics;
            }
        }
        catch (err) {
            conn.console.info(getErrorMessage(err, document));
            connection.sendNotification(StatusNotification.type, { state: Status.error });
            trace(`No linting: tslint exception while linting`);
            return diagnostics;
        }
        if (result.failures.length > 0) {
            filterProblemsForDocument(fsPath, result.failures).forEach(problem => {
                let diagnostic = makeDiagnostic(settings, problem);
                diagnostics.push(diagnostic);
                recordCodeAction(document, diagnostic, problem);
            });
        }
        connection.sendNotification(StatusNotification.type, { state: Status.ok });
        return diagnostics;
    });
}
/**
 * Filter failures for the given document
 */
function filterProblemsForDocument(documentPath, failures) {
    let normalizedPath = path.normalize(documentPath);
    // we only show diagnostics targetting this open document, some tslint rule return diagnostics for other documents/files
    let normalizedFiles = {};
    return failures.filter(each => {
        let fileName = each.getFileName();
        if (!normalizedFiles[fileName]) {
            normalizedFiles[fileName] = path.normalize(fileName);
        }
        return normalizedFiles[fileName] === normalizedPath;
    });
}
function isJsDocument(document) {
    return (document.languageId === "javascript" || document.languageId === "javascriptreact");
}
function fileIsExcluded(settings, path) {
    function testForExclusionPattern(path, pattern) {
        return minimatch(path, pattern, { dot: true });
    }
    if (settings.ignoreDefinitionFiles) {
        if (minimatch(path, "**/*.d.ts", { dot: true })) {
            return true;
        }
    }
    if (settings.exclude) {
        if (Array.isArray(settings.exclude)) {
            for (let pattern of settings.exclude) {
                if (testForExclusionPattern(path, pattern)) {
                    return true;
                }
            }
        }
        else if (testForExclusionPattern(path, settings.exclude)) {
            return true;
        }
    }
    return false;
}
documents.onDidOpen((event) => __awaiter(this, void 0, void 0, function* () {
    let settings = yield settingsCache.get(event.document.uri);
    triggerValidateDocument(event.document);
}));
documents.onDidChangeContent((event) => __awaiter(this, void 0, void 0, function* () {
    let settings = yield settingsCache.get(event.document.uri);
    if (settings && settings.run === 'onType') {
        triggerValidateDocument(event.document);
    }
    else if (settings && settings.run === 'onSave') {
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    }
}));
documents.onDidSave((event) => __awaiter(this, void 0, void 0, function* () {
    let settings = yield settingsCache.get(event.document.uri);
    if (settings && settings.run === 'onSave') {
        triggerValidateDocument(event.document);
    }
}));
documents.onDidClose((event) => {
    // A text document was closed we clear the diagnostics
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    document2Library.delete(event.document.uri);
});
function triggerValidateDocument(document) {
    let d = validationDelayer[document.uri];
    if (!d) {
        d = new delayer_1.Delayer(200);
        validationDelayer[document.uri] = d;
    }
    d.trigger(() => {
        validateTextDocument(connection, document);
        delete validationDelayer[document.uri];
    });
}
function tslintConfigurationValid() {
    try {
        documents.all().forEach((each) => {
            let fsPath = server.Files.uriToFilePath(each.uri);
            if (fsPath) {
                // TODO getConfiguration(fsPath, configFile);
            }
        });
    }
    catch (err) {
        connection.console.info(getConfigurationFailureMessage(err));
        connection.sendNotification(StatusNotification.type, { state: Status.error });
        return false;
    }
    return true;
}
// The VS Code tslint settings have changed. Revalidate all documents.
connection.onDidChangeConfiguration((params) => {
    globalSettings = params.settings;
    configCache.flush();
    settingsCache.flush();
    validateAllTextDocuments(connection, documents.all());
});
// The watched tslint.json has changed. Revalidate all documents, IF the configuration is valid.
connection.onDidChangeWatchedFiles((params) => {
    // Tslint 3.7 started to load configuration files using 'require' and they are now
    // cached in the node module cache. To ensure that the extension uses
    // the latest configuration file we remove the config file from the module cache.
    params.changes.forEach(element => {
        let configFilePath = server.Files.uriToFilePath(element.uri);
        if (configFilePath) {
            let cached = require.cache[configFilePath];
            if (cached) {
                delete require.cache[configFilePath];
            }
        }
    });
    configCache.flush();
    if (tslintConfigurationValid()) {
        validateAllTextDocuments(connection, documents.all());
    }
});
connection.onCodeAction((params) => {
    let result = [];
    let uri = params.textDocument.uri;
    let documentVersion = -1;
    let ruleId = undefined;
    let documentFixes = codeFixActions[uri];
    if (documentFixes) {
        for (let diagnostic of params.context.diagnostics) {
            let autoFix = documentFixes[computeKey(diagnostic)];
            if (autoFix) {
                documentVersion = autoFix.documentVersion;
                ruleId = autoFix.problem.getRuleName();
                result.push(server.Command.create(autoFix.label, '_tslint.applySingleFix', uri, documentVersion, createTextEdit(autoFix)));
            }
        }
        if (result.length > 0) {
            let same = [];
            let all = [];
            let fixes = Object.keys(documentFixes).map(key => documentFixes[key]);
            fixes = sortFixes(fixes);
            for (let autofix of fixes) {
                if (documentVersion === -1) {
                    documentVersion = autofix.documentVersion;
                }
                if (autofix.problem.getRuleName() === ruleId && !overlaps(getLastEdit(same), autofix)) {
                    same.push(autofix);
                }
                if (!overlaps(getLastEdit(all), autofix)) {
                    all.push(autofix);
                }
            }
            // if the same rule warning exists more than once, provide a command to fix all these warnings
            if (same.length > 1) {
                result.push(server.Command.create(`Fix all: ${same[0].problem.getFailure()}`, '_tslint.applySameFixes', uri, documentVersion, concatenateEdits(same)));
            }
            // create a command to fix all the warnings with fixes
            if (all.length > 1) {
                result.push(server.Command.create(`Fix all auto-fixable problems`, '_tslint.applyAllFixes', uri, documentVersion, concatenateEdits(all)));
            }
        }
    }
    // add the fix to disable the rule
    let disableRuleFixes = codeDisableRuleActions[uri];
    if (disableRuleFixes) {
        for (let diagnostic of params.context.diagnostics) {
            let autoFix = disableRuleFixes[computeKey(diagnostic)];
            if (autoFix) {
                documentVersion = autoFix.documentVersion;
                ruleId = autoFix.problem.getRuleName();
                result.push(server.Command.create(autoFix.label, '_tslint.applyDisableRule', uri, documentVersion, createTextEdit(autoFix)));
            }
        }
    }
    // quick fix to show the rule documentation
    if (documentFixes) {
        for (let diagnostic of params.context.diagnostics) {
            let autoFix = disableRuleFixes[computeKey(diagnostic)];
            if (autoFix) {
                documentVersion = autoFix.documentVersion;
                let ruleId = autoFix.problem.getRuleName();
                result.push(server.Command.create(`Show documentation for "${ruleId}"`, '_tslint.showRuleDocumentation', uri, documentVersion, undefined, ruleId));
            }
        }
    }
    return result;
});
function replacementsAreEmpty(fix) {
    // in tslint 4 a Fix has a replacement property witht the Replacements
    if (fix.replacements) {
        return fix.replacements.length === 0;
    }
    // tslint 5
    if (Array.isArray(fix)) {
        return fix.length === 0;
    }
    return false;
}
function createAutoFix(problem, document, fix) {
    let edits = [];
    function isTslintAutofixEdit(fix) {
        return fix.range !== undefined;
    }
    if (isTslintAutofixEdit(fix)) {
        edits = [fix];
    }
    else {
        let ff = fix;
        // in tslint4 a Fix has a replacement property with the Replacements
        if (ff.replacements) {
            // tslint4
            edits = ff.replacements.map(each => convertReplacementToAutoFix(document, each));
        }
        else {
            // in tslint 5 a Fix is a Replacment | Replacement[]
            if (!Array.isArray(fix)) {
                fix = [fix];
            }
            edits = fix.map(each => convertReplacementToAutoFix(document, each));
        }
    }
    let autofix = {
        label: `Fix: ${problem.getFailure()}`,
        documentVersion: document.version,
        problem: problem,
        edits: edits,
    };
    return autofix;
}
function createDisableRuleFix(problem, document) {
    let pos = {
        character: 0,
        line: problem.getStartPosition().getLineAndCharacter().line
    };
    let disableEdit = {
        range: [pos, pos],
        // prefix to the text will be inserted on the client
        text: `// tslint:disable-next-line:${problem.getRuleName()}\n`
    };
    let disableFix = {
        label: `Disable rule "${problem.getRuleName()}"`,
        documentVersion: document.version,
        problem: problem,
        edits: [disableEdit]
    };
    return disableFix;
}
function sortFixes(fixes) {
    // The AutoFix.edits are sorted, so we sort on the first edit
    return fixes.sort((a, b) => {
        let editA = a.edits[0];
        let editB = b.edits[0];
        if (editA.range[0] < editB.range[0]) {
            return -1;
        }
        if (editA.range[0] > editB.range[0]) {
            return 1;
        }
        // lines are equal
        if (editA.range[1] < editB.range[1]) {
            return -1;
        }
        if (editA.range[1] > editB.range[1]) {
            return 1;
        }
        // characters are equal
        return 0;
    });
}
function overlaps(lastFix, nextFix) {
    if (!lastFix) {
        return false;
    }
    let doesOverlap = false;
    lastFix.edits.some(last => {
        return nextFix.edits.some(next => {
            if (last.range[1].line > next.range[0].line) {
                doesOverlap = true;
                return true;
            }
            else if (last.range[1].line < next.range[0].line) {
                return false;
            }
            else if (last.range[1].character >= next.range[0].character) {
                doesOverlap = true;
                return true;
            }
            return false;
        });
    });
    return doesOverlap;
}
exports.overlaps = overlaps;
function getLastEdit(array) {
    let length = array.length;
    if (length === 0) {
        return undefined;
    }
    return array[length - 1];
}
function getAllNonOverlappingFixes(fixes) {
    let nonOverlapping = [];
    fixes = sortFixes(fixes);
    for (let autofix of fixes) {
        if (!overlaps(getLastEdit(nonOverlapping), autofix)) {
            nonOverlapping.push(autofix);
        }
    }
    return nonOverlapping;
}
exports.getAllNonOverlappingFixes = getAllNonOverlappingFixes;
function createTextEdit(autoFix) {
    return autoFix.edits.map(each => server.TextEdit.replace(server.Range.create(each.range[0], each.range[1]), each.text || ''));
}
var AllFixesRequest;
(function (AllFixesRequest) {
    AllFixesRequest.type = new server.RequestType('textDocument/tslint/allFixes');
})(AllFixesRequest || (AllFixesRequest = {}));
connection.onRequest(AllFixesRequest.type, (params) => __awaiter(this, void 0, void 0, function* () {
    let result = undefined;
    let uri = params.textDocument.uri;
    let isOnSave = params.isOnSave;
    let documentFixes = codeFixActions[uri];
    let documentVersion = -1;
    let settings = yield settingsCache.get(uri);
    if (!documentFixes) {
        return undefined;
    }
    let fixes = Object.keys(documentFixes).map(key => documentFixes[key]);
    for (let fix of fixes) {
        if (documentVersion === -1) {
            documentVersion = fix.documentVersion;
            break;
        }
    }
    // Filter out fixes for problems that aren't defined to be autofixable on save
    if (isOnSave && settings && Array.isArray(settings.autoFixOnSave)) {
        const autoFixOnSave = settings.autoFixOnSave;
        fixes = fixes.filter(fix => autoFixOnSave.indexOf(fix.problem.getRuleName()) > -1);
    }
    let allFixes = getAllNonOverlappingFixes(fixes);
    result = {
        documentVersion: documentVersion,
        edits: concatenateEdits(allFixes)
    };
    return result;
}));
function concatenateEdits(fixes) {
    let textEdits = [];
    fixes.forEach(each => {
        textEdits = textEdits.concat(createTextEdit(each));
    });
    return textEdits;
}
function traceConfigurationFile(configuration) {
    if (!configuration) {
        trace("no tslint configuration");
        return;
    }
    trace("tslint configuration:", util.inspect(configuration, undefined, 4));
}
function resolveGlobalPackageManagerPath(settings) {
    if (settings.packageManager === 'npm') {
        resolveGlobalNpmPath(settings);
    }
    else if (settings.packageManager === 'yarn') {
        resolveGlobalYarnPath(settings);
    }
}
function resolveGlobalNpmPath(settings) {
    if (!settings.didResolveGlobalPackageMangerPath) {
        settings.didResolveGlobalPackageMangerPath = true;
        settings.resolvedGlobalPackageManagerPath = server.Files.resolveGlobalNodePath(trace);
    }
    return settings.resolvedGlobalPackageManagerPath;
}
function resolveGlobalYarnPath(settings) {
    if (!settings.didResolveGlobalPackageMangerPath) {
        settings.didResolveGlobalPackageMangerPath = true;
        settings.resolvedGlobalPackageManagerPath = server.Files.resolveGlobalYarnPath(trace);
    }
    return settings.resolvedGlobalPackageManagerPath;
}
connection.listen();
//# sourceMappingURL=server.js.map