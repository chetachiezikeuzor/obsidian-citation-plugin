import {
  FileSystemAdapter,
  MarkdownPostProcessor,
  MarkdownPostProcessorContext,
  MarkdownSourceView,
  MarkdownPreviewView,
  MarkdownView,
  normalizePath,
  Plugin,
  TFile,
  WorkspaceLeaf,
  View,
} from 'obsidian';
import * as path from 'path';
import * as chokidar from 'chokidar';
import type CodeMirror from 'codemirror';

import {
  compile as compileTemplate,
  TemplateDelegate as Template,
} from 'handlebars';

import CitationService from './citation-service';
import {
  InsertCitationModal,
  InsertNoteLinkModal,
  InsertNoteContentModal,
  OpenNoteModal,
} from './modals';
import type { VaultExt, WorkspaceExt } from './obsidian-extensions.d';
import { CitationSettingTab, CitationsPluginSettings } from './settings';
import CitationStatusBarItem from './status-bar';
import {
  Entry,
  EntryData,
  EntryBibLaTeXAdapter,
  EntryCSLAdapter,
  IIndexable,
  Library,
} from './types';
import {
  DISALLOWED_FILENAME_CHARACTERS_RE,
  Notifier,
  WorkerManager,
  WorkerManagerBlocked,
} from './util';
import LoadWorker from 'web-worker:./worker';
import { CitationsView } from './view';

export default class CitationPlugin extends Plugin {
  // Services
  settings: CitationsPluginSettings;
  library: Library;
  citationService = new CitationService();

  // UI members/constants
  VIEW_TYPE_CITATIONS = 'citations';
  VIEW_SIDE: 'left' | 'right' = 'right';
  statusBarItem: CitationStatusBarItem;

  // Template compilation options
  private templateSettings = {
    noEscape: true,
  };

  private loadWorker = new WorkerManager(new LoadWorker(), {
    blockingChannel: true,
  });

  loadErrorNotifier = new Notifier(
    'Unable to load citations. Please update Citations plugin settings.',
  );
  literatureNoteErrorNotifier = new Notifier(
    'Unable to access literature note. Please check that the literature note folder exists, or update the Citations plugin settings.',
  );

  get editor(): CodeMirror.Editor {
    const view = this.app.workspace.activeLeaf.view;
    if (!(view instanceof MarkdownView)) return null;

    const sourceView = view.sourceMode;
    return (sourceView as MarkdownSourceView).cmEditor;
  }

  async loadSettings(): Promise<void> {
    this.settings = new CitationsPluginSettings();

    const loadedSettings = await this.loadData();
    if (!loadedSettings) return;

    const toLoad = [
      'citationExportPath',
      'citationExportFormat',
      'literatureNoteTitleTemplate',
      'literatureNoteFolder',
      'literatureNoteContentTemplate',
      'markdownCitationTemplate',
      'alternativeMarkdownCitationTemplate',
    ];
    toLoad.forEach((setting) => {
      if (setting in loadedSettings) {
        (this.settings as IIndexable)[setting] = loadedSettings[setting];
      }
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onload(): void {
    this.loadSettings().then(() => this.init());

    // Prepare Citations view
    this.registerView(
      this.VIEW_TYPE_CITATIONS,
      this.createCitationsView.bind(this),
    );
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        console.log('menu', menu, file, source);
        menu.addItem((mitem) => {
          mitem.setTitle('Open citations').onClick(() => {
            this.initLeaf();
            console.log('here');
            this.app.workspace
              .splitLeafOrActive(leaf, 'vertical')
              .setViewState({
                type: this.VIEW_TYPE_CITATIONS,
                active: true,
                state: { file: file.path, abc: 'xyz' },
                group: leaf,
              });
          });
        });
      }),
    );

    // Prepare preview leaf postprocessor
    this.registerMarkdownPostProcessor(this.postProcessMarkdown.bind(this));
  }

  async init(): Promise<void> {
    if (this.settings.citationExportPath) {
      // Load library for the first time
      this.loadLibrary();

      // Set up a watcher to refresh whenever the export is updated
      try {
        // Wait until files are finished being written before going ahead with
        // the refresh -- here, we request that `change` events be accumulated
        // until nothing shows up for 500 ms
        // TODO magic number
        const watchOptions = {
          awaitWriteFinish: {
            stabilityThreshold: 500,
          },
        };

        chokidar
          .watch(
            this.resolveLibraryPath(this.settings.citationExportPath),
            watchOptions,
          )
          .on('change', () => {
            this.loadLibrary();
          });
      } catch {
        this.loadErrorNotifier.show();
      }
    } else {
      // TODO show warning?
    }

    this.addCommand({
      id: 'open-literature-note',
      name: 'Open literature note',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'o' }],
      callback: () => {
        const modal = new OpenNoteModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'update-bib-data',
      name: 'Refresh citation database',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'r' }],
      callback: () => {
        this.loadLibrary();
      },
    });

    this.addCommand({
      id: 'insert-citation',
      name: 'Insert literature note link',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'e' }],
      callback: () => {
        const modal = new InsertNoteLinkModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-literature-note-content',
      name: 'Insert literature note content in the current pane',
      callback: () => {
        const modal = new InsertNoteContentModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-markdown-citation',
      name: 'Insert Markdown citation',
      callback: () => {
        const modal = new InsertCitationModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'open-citations-view',
      name: 'Open Citations panel',
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (
            this.app.workspace.getLeavesOfType(this.VIEW_TYPE_CITATIONS)
              .length == 0
          );
        }

        this.initLeaf();
      },
    });

    this.addSettingTab(new CitationSettingTab(this.app, this));

    this.statusBarItem = new CitationStatusBarItem(this);
    this.statusBarItem.onload();
  }

  /**
   * Resolve a provided library path, allowing for relative paths rooted at
   * the vault directory.
   */
  resolveLibraryPath(rawPath: string): string {
    const vaultRoot =
      this.app.vault.adapter instanceof FileSystemAdapter
        ? this.app.vault.adapter.getBasePath()
        : '/';
    return path.resolve(vaultRoot, rawPath);
  }

  async loadLibrary(): Promise<Library> {
    console.debug('Citation plugin: Reloading library');
    if (this.settings.citationExportPath) {
      const filePath = this.resolveLibraryPath(
        this.settings.citationExportPath,
      );

      // Unload current library.
      this.library = null;

      return FileSystemAdapter.readLocalFile(filePath)
        .then((buffer) => {
          // If there is a remaining error message, hide it
          this.loadErrorNotifier.hide();

          // Decode file as UTF-8.
          const dataView = new DataView(buffer);
          const decoder = new TextDecoder('utf8');
          const value = decoder.decode(dataView);

          return this.loadWorker.post({
            databaseRaw: value,
            databaseType: this.settings.citationExportFormat,
          });
        })
        .then((entries: EntryData[]) => {
          let adapter: new (data: EntryData) => Entry;
          let idKey: string;

          switch (this.settings.citationExportFormat) {
            case 'biblatex':
              adapter = EntryBibLaTeXAdapter;
              idKey = 'key';
              break;
            case 'csl-json':
              adapter = EntryCSLAdapter;
              idKey = 'id';
              break;
          }

          this.library = new Library(
            Object.fromEntries(
              entries.map((e) => [(e as IIndexable)[idKey], new adapter(e)]),
            ),
          );
          this.citationService.library = this.library;

          this.statusBarItem.updateCitationCount(null);

          console.debug(
            `Citation plugin: successfully loaded library with ${this.library.size} entries.`,
          );

          return this.library;
        })
        .catch((e) => {
          if (e instanceof WorkerManagerBlocked) {
            // Silently catch WorkerManager error, which will be thrown if the
            // library is already being loaded
            return;
          }

          console.error(e);
          this.loadErrorNotifier.show();

          return null;
        });
    } else {
      console.warn(
        'Citations plugin: citation export path is not set. Please update plugin settings.',
      );
    }
  }

  /**
   * Returns true iff the library is currently being loaded on the worker thread.
   */
  get isLibraryLoading(): boolean {
    return this.loadWorker.blocked;
  }

  get literatureNoteTitleTemplate(): Template {
    return compileTemplate(
      this.settings.literatureNoteTitleTemplate,
      this.templateSettings,
    );
  }

  get literatureNoteContentTemplate(): Template {
    return compileTemplate(
      this.settings.literatureNoteContentTemplate,
      this.templateSettings,
    );
  }

  get markdownCitationTemplate(): Template {
    return compileTemplate(
      this.settings.markdownCitationTemplate,
      this.templateSettings,
    );
  }

  get alternativeMarkdownCitationTemplate(): Template {
    return compileTemplate(
      this.settings.alternativeMarkdownCitationTemplate,
      this.templateSettings,
    );
  }

  getTitleForCitekey(citekey: string): string {
    const unsafeTitle = this.literatureNoteTitleTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
    return unsafeTitle.replace(DISALLOWED_FILENAME_CHARACTERS_RE, '_');
  }

  getPathForCitekey(citekey: string): string {
    const title = this.getTitleForCitekey(citekey);
    // TODO escape note title
    return path.join(this.settings.literatureNoteFolder, `${title}.md`);
  }

  getInitialContentForCitekey(citekey: string): string {
    return this.literatureNoteContentTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
  }

  getMarkdownCitationForCitekey(citekey: string): string {
    return this.markdownCitationTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
  }

  getAlternativeMarkdownCitationForCitekey(citekey: string): string {
    return this.alternativeMarkdownCitationTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
  }

  /**
   * Run a case-insensitive search for the literature note file corresponding to
   * the given citekey. If no corresponding file is found, create one.
   */
  async getOrCreateLiteratureNoteFile(citekey: string): Promise<TFile> {
    const path = this.getPathForCitekey(citekey);
    const normalizedPath = normalizePath(path);

    let file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (file == null) {
      // First try a case-insensitive lookup.
      const matches = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.toLowerCase() == normalizedPath.toLowerCase());
      if (matches.length > 0) {
        file = matches[0];
      } else {
        try {
          file = await this.app.vault.create(
            path,
            this.getInitialContentForCitekey(citekey),
          );
        } catch (exc) {
          this.literatureNoteErrorNotifier.show();
          throw exc;
        }
      }
    }

    return file as TFile;
  }

  async openLiteratureNote(citekey: string, newPane: boolean): Promise<void> {
    this.getOrCreateLiteratureNoteFile(citekey)
      .then((file: TFile) => {
        this.app.workspace.getLeaf(newPane).openFile(file);
      })
      .catch(console.error);
  }

  async insertLiteratureNoteLink(citekey: string): Promise<void> {
    this.getOrCreateLiteratureNoteFile(citekey)
      .then((file: TFile) => {
        const useMarkdown: boolean = (<VaultExt>this.app.vault).getConfig(
          'useMarkdownLinks',
        );
        const title = this.getTitleForCitekey(citekey);

        let linkText: string;
        if (useMarkdown) {
          const uri = encodeURI(
            this.app.metadataCache.fileToLinktext(file, '', false),
          );
          linkText = `[${title}](${uri})`;
        } else {
          linkText = `[[${title}]]`;
        }

        this.editor.replaceRange(linkText, this.editor.getCursor());
      })
      .catch(console.error);
  }

  /**
   * Format literature note content for a given reference and insert in the
   * currently active pane.
   */
  async insertLiteratureNoteContent(citekey: string): Promise<void> {
    const content = this.getInitialContentForCitekey(citekey);
    this.editor.replaceRange(content, this.editor.getCursor());
  }

  async insertMarkdownCitation(
    citekey: string,
    alternative = false,
  ): Promise<void> {
    const func = alternative
      ? this.getAlternativeMarkdownCitationForCitekey
      : this.getMarkdownCitationForCitekey;
    const citation = func.bind(this)(citekey);

    this.editor.replaceRange(citation, this.editor.getCursor());
  }

  createCitationsView(leaf: WorkspaceLeaf): View {
    console.log('create with leaf', leaf);
    return new CitationsView(leaf, this);
  }

  initLeaf(): void {
    if (
      this.app.workspace.getLeavesOfType(this.VIEW_TYPE_CITATIONS).length != 0
    )
      return;

    this.app.workspace
      .getRightLeaf(false)
      .setViewState({ type: this.VIEW_TYPE_CITATIONS });
  }

  openLeaf(): void {
    (<WorkspaceExt>this.app.workspace).ensureSideLeaf(
      this.VIEW_TYPE_CITATIONS,
      this.VIEW_SIDE,
      false,
    );
  }

  /**
   * Post-process rendered Markdown content, replacing any detected citations
   * with inline references from citeproc.
   */
  postProcessMarkdown(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): void {
    // TODO trigger preview re-render when library loads.
    if (!this.library) return;

    // TODO handle chain of references
    el.querySelectorAll('a.internal-link').forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) return;

      const match = link.pathname.match(/^\/(@(.+))$/);
      if (match) {
        const [, fullMatch, citekey] = match;
        const entry = this.library.entries[citekey];
        if (entry) {
          // Render inline citation.
          const citation = this.citationService.getCitation(citekey, true);
          if (citation.includes('NO_PRINTED_FORM')) {
            // Error in generating citation. Quit.
            return;
          }

          link.innerHTML = link.innerHTML.replace(fullMatch, citation);
          link.addClass('citation-link');
        }
      }
    });
  }

  /**
   * Extract a list of citations from the given Markdown string.
   * Each element of the list is a 2-tuple consisting of an individual
   * citation's corresponding `Entry` in the library (if it exists, or null),
   * and the originating citation string including line context in the content.
   */
  getCitations(content: string): [Entry, string][] {
    if (!this.library) {
      return null;
    }

    // TODO support other citation formats
    const matches = content.matchAll(
      /^.*\[\[?@([^\]]+?)(?:[#^]+[^\]]+)?\]\]?.*$/gm,
    );
    const results: [Entry, string][] = [...matches].map((match) => {
      const [line, citekey] = match;
      return [this.library.entries[citekey], line] as [Entry, string];
    });

    return results;
  }
}
