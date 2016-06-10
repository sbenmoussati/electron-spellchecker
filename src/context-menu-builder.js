import {clipboard, nativeImage, remote, shell} from 'electron';

import DictionarySync from './dictionary-sync';
import EventActions from '../actions/event-actions';

const {Menu, MenuItem} = remote;

const d = require('debug')('electron-spellchecker:context-menu-builder');

export default class ContextMenuBuilder {
  constructor(windowOrWebView=null, debugMode=false) {
    this.windowOrWebView = this.windowOrWebView || remote.getCurrentWindow();
    this.debugMode = debugMode;
    this.menu = null;
  }
  
  showPopupMenu(contextInfo) {
    let menu = this.buildMenuForElement(contextInfo);

    // Opening a menu blocks the renderer process, which is definitely not
    // suitable for running tests
    if (!menu) return;
    menu.popup(remote.getCurrentWindow());
  }
  
  /**  
   * Builds a context menu specific to the given info.
   *    
   * @param  {Object} info
   * @param  {String} info.type       The type of menu to build
   * @param  {String} info.selection  The selected text string
   * @param  {String} info.id         The element ID
   * @param  {Number} info.x          The x coordinate of the click location
   * @param  {Number} info.y          The y coordinate of the click location
   * @param  {String} info.href       The href for `a` elements
   * @param  {String} info.src        The src for `img` elements
   * 
   * @return {Menu}      The newly created `Menu`   
   */   
  buildMenuForElement(info) {
    d(`Got context menu event with args: ${JSON.stringify(info)}`);

    switch (info.type) {
    case 'textInput':
      return this.buildMenuForTextInput(info);
    case 'link':
      return this.buildMenuForLink(info);
    case 'text':
      return this.buildMenuForText(info);
    default:
      return this.buildDefaultMenu(info);
    }
  }

  /**  
   * Builds a menu applicable to a text input field.
   *    
   * @return {Menu}  The `Menu`   
   */   
  buildMenuForTextInput(menuInfo) {
    let menu = new Menu();

    this.addSpellingItems(menu, menuInfo);
    this.addSearchItems(menu, menuInfo);

    this.addCut(menu);
    this.addCopy(menu);
    this.addPaste(menu);
    this.addInspectElement(menu);

    return menu;
  }

  /**  
   * Builds a menu applicable to a link element.
   *    
   * @return {Menu}  The `Menu`   
   */   
  buildMenuForLink(menuInfo) {
    let menu = new Menu();
    let isEmailAddress = menuInfo.href.startsWith('mailto:');

    let copyLink = new MenuItem({
      label: isEmailAddress ? 'Copy Email Address' : 'Copy Link',
      click: () => {
        // Omit the mailto: portion of the link; we just want the address
        clipboard.writeText(isEmailAddress ? 
          menuInfo.href.replace(/^mailto:/i, '') :
          menuInfo.href);
      }
    });

    let openLink = new MenuItem({
      label: 'Open Link',
      click: () => {
        d(`Navigating to: ${menuInfo.href}`);
        shell.openExternal(menuInfo.href);
      }
    });

    menu.append(copyLink);
    menu.append(openLink);

    this.addImageItems(menu, menuInfo);
    this.addInspectElement(menu);

    return menu;
  }

  /**  
   * Builds a menu applicable to a text field.
   *    
   * @return {Menu}  The `Menu`   
   */   
  buildMenuForText(menuInfo) {
    let menu = new Menu();

    this.addSearchItems(menu, menuInfo);
    this.addCopy(menu);
    this.addInspectElement(menu);

    return menu;
  }

  /**  
   * Builds an empty menu or one with the 'Inspect Element' item.
   *    
   * @return {Menu}  The `Menu`   
   */   
  buildDefaultMenu() {
    // NB: Mac handles empty menus properly, ignoring the event entirely.
    // Windows will render a dummy (empty) item.
    let emptyMenu = process.platform === 'darwin' ? new Menu() : null;
    return this.debugMode ? this.addInspectElement(new Menu(), false) : emptyMenu;
  }

  /**  
   * Checks if the current text selection contains a single misspelled word and
   * if so, adds suggested spellings as individual menu items. 
   */   
  addSpellingItems(menu, menuInfo) {
    // XXX: This is all fucked
    if (!(menuInfo.selection && this.info.currentLanguage))
      return menu;

    // Ensure that we have a spell-checker for this language
    let spellChecker = this.spellCheckers[this.info.currentLanguage];
    if (!spellChecker)
      return menu;

    // Ensure that the text selection is a single misspelled word
    let isSingleWord = !this.info.selection.match(/\s/);
    let isMisspelled = spellChecker.isMisspelled(this.info.selection);
    if (!isSingleWord || !isMisspelled)
      return menu;

    // Ensure that we have valid corrections for that word
    let corrections = spellChecker.getCorrectionsForMisspelling(this.info.selection);
    if (!corrections || !corrections.length)
      return menu;

    corrections.forEach((correction) => {
      let item = new MenuItem({
        label: correction,
        click: () => this.webView.replaceMisspelling(correction)
      });
    
      menu.append(item);
    });
    
    this.addSeparator(menu);

    // Gate learning words based on OS support. At some point we can manage a
    // custom dictionary for Hunspell, but today is not that day
    if (!DictionarySync.shouldUseHunspell()) {
      let learnWord = new MenuItem({
        label: `Add to Dictionary`,
        click: () => {
          spellChecker.add(this.info.selection);

          // NB: This is a gross fix to invalidate the spelling underline,
          // refer to https://github.com/tinyspeck/slack-winssb/issues/354
          this.webView.replaceMisspelling(this.info.selection);
        }
      });
      menu.append(learnWord);
    }

    return menu;
  }

  /**  
   * Adds search-related menu items.
   */
  addSearchItems(menu, menuInfo) {
    if (!menuInfo.selection)
      return menu;

    let match = menuInfo.selection.match(/\w/);
    if (!match || match.length === 0) {
      return menu;
    }

    let search = new MenuItem({
      label: 'Search with Google',
      click: () => {
        let url = `https://www.google.com/#q=${encodeURIComponent(this.info.selection)}`;

        d(`Searching Google using ${url}`);
        shell.openExternal(url);
      }
    });

    menu.append(search);
    this.addSeparator(menu);
  
    return menu;
  }

  /**  
   * Adds "Copy Image" and "Copy Image URL" items when `src` is valid.
   */   
  addImageItems(menu, menuInfo) {
    if (!menuInfo.src || menuInfo.src.length === 0) {
      return menu;
    }

    this.addSeparator(menu);

    let copyImage = new MenuItem({
      label: 'Copy Image',
      click: () => this.convertImageToBase64(this.info.src,
        (dataURL) => clipboard.writeImage(nativeImage.createFromDataUrl(dataURL)))
    });
  
    menu.append(copyImage);

    let copyImageUrl = new MenuItem({
      label: 'Copy Image URL',
      click: () => clipboard.writeText(this.info.src)
    });

    menu.append(copyImageUrl);
    return menu;
  }

  /**  
   * Adds the Cut menu item
   */   
  addCut(menu) {
    let target = 'webContents' in this.windowOrWebView ? 
      this.windowOrWebView.webContents : this.windowOrWebView;
      
    menu.append(new MenuItem({
      label: 'Cut',
      accelerator: 'CommandOrControl+X',
      click: () => target.cut()
    }));

    return menu;
  }

  /**  
   * Adds the Copy menu item.
   */   
  addCopy(menu) {
    let target = 'webContents' in this.windowOrWebView ? 
      this.windowOrWebView.webContents : this.windowOrWebView;
    
    menu.append(new MenuItem({
      label: 'Copy',
      accelerator: 'CommandOrControl+C',
      click: () => target.copy()
    }));

    return menu;
  }

  /**  
   * Adds the Paste menu item.
   */   
  addPaste(menu) {
    let target = 'webContents' in this.windowOrWebView ? 
      this.windowOrWebView.webContents : this.windowOrWebView;
    
    menu.append(new MenuItem({
      label: 'Paste',
      accelerator: 'CommandOrControl+V',
      click: () => target.paste()
    }));

    return menu;
  }
  
  /**  
   * Adds a separator item.
   */   
  addSeparator(menu) {
    menu.append(new MenuItem({type: 'separator'}));
    return menu;
  }

  /**  
   * Adds the "Inspect Element" menu item.
   */   
  addInspectElement(menu, needsSeparator=true) {
    let target = 'webContents' in this.windowOrWebView ? 
      this.windowOrWebView.webContents : this.windowOrWebView;
    
    if (!this.devMode) return menu;
    if (needsSeparator) this.addSeparator(menu);

    let inspect = new MenuItem({
      label: 'Inspect Element',
      click: () => target.inspectElement(this.info.x, this.info.y)
    });

    menu.append(inspect);
    return menu;
  }

  /**  
   * Converts an image to a base-64 encoded string.
   *    
   * @param  {String} url           The image URL   
   * @param  {Function} callback    A callback that will be invoked with the result   
   * @param  {String} outputFormat  The image format to use, defaults to 'image/png'   
   */   
  convertImageToBase64(url, callback, outputFormat='image/png') {
    let canvas = document.createElement('CANVAS');
    let ctx = canvas.getContext('2d');
    let img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
      canvas.height = img.height;
      canvas.width = img.width;
      ctx.drawImage(img, 0, 0);

      let dataURL = canvas.toDataURL(outputFormat);
      canvas = null;
      callback(dataURL);
    };

    img.src = url;
  }
}
