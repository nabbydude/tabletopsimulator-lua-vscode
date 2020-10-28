export default class BBCode {
  codes: any[] = [];

  /**
   * @param {Object} codes
   */
  constructor(codes: { [key: string]: string }) {
    this.setCodes(codes);
  }

  /**
   * parse
   *
   * @param {String} text
   * @returns {String}
   */
  parse(text: string) {
    return this.codes.reduce((t, code) => t.replace(code.regexp, code.replacement), text);
  }

  /**
   * add bb codes
   *
   * @param {String} regex
   * @param {String} replacement
   * @returns {BBCode}
   */
  add(regex: string, replacement: string) {
    this.codes.push({
      regexp: new RegExp(regex, 'igm'),
      replacement,
    });

    return this;
  }

  /**
   * set bb codes
   *
   * @param {Object} codes
   * @returns {BBCode}
   */
  setCodes(codes: { [key: string]: string }) {
    this.codes = Object.keys(codes).map((regex: string) => {
      const replacement = codes[regex];

      return {
        regexp: new RegExp(regex, 'igm'),
        replacement,
      };
    }, this);

    return this;
  }
}
