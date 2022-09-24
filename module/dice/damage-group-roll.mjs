import DamageRoll from "./damage-roll.mjs";

/**
 * A type of Roll specific to a damage (or healing) roll in the 5e system.
 * @param {Array<Array<string>>} parts                       Damage Parts in this Group
 * @param {object} data                          The data object against which to parse attributes within the formula
 * @param {object} [options={}]                  Extra optional arguments which describe or modify the DamageRoll
 * @param {number} [options.criticalBonusDice=0]      A number of bonus damage dice that are added for critical hits
 * @param {number} [options.criticalMultiplier=2]     A critical hit multiplier which is applied to critical hits
 * @param {boolean} [options.multiplyNumeric=false]   Multiply numeric terms by the critical multiplier
 * @param {boolean} [options.powerfulCritical=false]  Apply the "powerful criticals" house rule to critical hits
 * @param {string} [options.criticalBonusDamage]      An extra damage term that is applied only on a critical hit
 */
export default class DamageGroupRoll {
  constructor(parts, data, options) {

    /**
     * Options which modify or describe the Roll
     * @type {object}
     */
     this.options = options;

     /**
      * Keep track of the parts being used for this DamageGroupRoll
      */
     this.parts = parts;

     this.data = data;

     /**
      * Has this DamageGroupRoll been evaluated yet?
      */
     this._evaluated = false;

    if ( !this.options.configured ) this.configureDamageGroup();
  }

  /* -------------------------------------------- */

  /**
   * The HTML template path used to configure evaluation of this Roll
   * @type {string}
   */
  static EVALUATION_TEMPLATE = "systems/dnd5e/templates/chat/roll-group-dialog.hbs";

  /* -------------------------------------------- */

  /**
   * A convenience reference for whether this DamageRoll is a critical hit
   * @type {boolean}
   */
  get isCritical() {
    return this.options.critical;
  }

  /* -------------------------------------------- */
  /*  Damage Roll Methods                         */
  /* -------------------------------------------- */

  /**
   * Apply optional modifiers which customize the behavior of the damage rolls.
   * @protected
   */
  configureDamageGroup() {
    // don't pass `criticalBonusDamage` through to `DamageRoll`
    const {criticalBonusDamage, flavor, ...damageRollOptions} = this.options;

    /** Keep track of the `DamageRoll` instances created for this DamageGroup */
    this._partRolls = this.parts.map(
      ([formula, damageType]) => new DamageRoll(formula, this.data, {...damageRollOptions, flavor: damageType ? CONFIG.DND5E.damageTypes[damageType] ?? damageType : ''})
    );

    // run `configureDamage` for each _partRoll
    this._partRolls.forEach((damageRoll) => {
      damageRoll.configureDamage();
    });

    // Add extra critical damage term
    if ( this.isCritical && this.options.criticalBonusDamage ) {
      const extra = new Roll(this.options.criticalBonusDamage, this.data, {
        flavor: game.i18n.localize('DND5E.ItemCritExtraDamage')
      });
      this._partRolls.push(extra);
    }

    // Mark configuration as complete
    this.options.configured = true;
  }

  /* -------------------------------------------- */

  /**
   * Evalute all rolls in this damage group
   * @returns A promise which resolves when all rolls are evaluated
   */
   async evaluate() {
    if ( this._evaluated ) {
      throw new Error(`The ${this.constructor.name} has already been evaluated and is now immutable`);
    }

    await Promise.all(this._partRolls.map(roll => roll.evaluate({async: true})));

    this.total = this._partRolls.reduce((total, roll) => total + roll.total, 0);

    this._evaluated = true;
  }

  /* -------------------------------------------- */

  /**
   * Creates a Chat Message with all of this Damage Group's rolls in one message
   */
  async toMessage(messageData={}, {rollMode, create=true}={}) {
    messageData.flavor = messageData.flavor || this.options.flavor;
    if ( this.isCritical ) {
      const label = game.i18n.localize("DND5E.CriticalHit");
      messageData.flavor = messageData.flavor ? `${messageData.flavor} (${label})` : label;
    }
    const messageRollMode = rollMode ?? this.options.rollMode;
    
    if ( !this._evaluated ) await this.evaluate();

    const content = await this.render();

    messageData = foundry.utils.mergeObject({
      user: game.user.id,
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      content,
      sound: CONFIG.sounds.dice
    }, messageData);

    messageData.rolls = this._partRolls;
    
    const cls = getDocumentClass("ChatMessage");
    const msg = new cls(messageData);
    
    // Either create or return the data
    if ( create ) return cls.create(msg.toObject(), { rollMode: messageRollMode });
    else {
      if ( messageRollMode ) msg.applyRollMode(messageRollMode);
      return msg.toObject();
    }
  }

  /**
   * Render the message content by simply rendering all individual rolls, and concatenating the strings
   */
  async render() {
    if ( !this._evaluated ) await this.evaluate();

    let content = '';

    for (const roll of this._partRolls) {
      content = content + await roll.render({flavor: roll.options.flavor});
    }

    const total = `<div class="dice-roll">
      <div class="dice-flavor">Total</div>
      <div class="dice-result"><h4 class="dice-total">${this.total}</h4></div>
    </div>`

    content = content + total;

    return content;
  }

  /* -------------------------------------------- */
  /*  Configuration Dialog                        */
  /* -------------------------------------------- */

  /**
   * Create a Dialog prompt used to configure evaluation of an existing D20Roll instance.
   * @param {object} data                     Dialog configuration data
   * @param {string} [data.title]               The title of the shown dialog window
   * @param {number} [data.defaultRollMode]     The roll mode that the roll mode select element should default to
   * @param {string} [data.defaultCritical]     Should critical be selected as default
   * @param {string} [data.template]            A custom path to an HTML template to use instead of the default
   * @param {boolean} [data.allowCritical=true] Allow critical hit to be chosen as a possible damage mode
   * @param {object} options                  Additional Dialog customization options
   * @returns {Promise<D20Roll|null>}         A resulting D20Roll object constructed with the dialog, or null if the
   *                                          dialog was closed
   */
  async configureDialog({title, defaultRollMode, defaultCritical=false, template, allowCritical=true}={}, options={}) {

    // Render the Dialog inner HTML
    const content = await renderTemplate(template ?? this.constructor.EVALUATION_TEMPLATE, {
      // formula: `${this.formula} + @bonus`,
      rollParts: this.parts,
      defaultRollMode,
      rollModes: CONFIG.Dice.rollModes
    });

    // Create the Dialog window and await submission of the form
    return new Promise(resolve => {
      new Dialog({
        title,
        content,
        buttons: {
          critical: {
            condition: allowCritical,
            label: game.i18n.localize("DND5E.CriticalHit"),
            callback: html => resolve(this._onDialogSubmit(html, true))
          },
          normal: {
            label: game.i18n.localize(allowCritical ? "DND5E.Normal" : "DND5E.Roll"),
            callback: html => resolve(this._onDialogSubmit(html, false))
          }
        },
        default: defaultCritical ? "critical" : "normal",
        close: () => resolve(null)
      }, options).render(true);
    });
  }

  /* -------------------------------------------- */

  /**
   * Handle submission of the Roll evaluation configuration Dialog
   * @param {jQuery} html         The submitted dialog content
   * @param {boolean} isCritical  Is the damage a critical hit?
   * @returns {DamageRoll}        This damage roll.
   * @private
   */
  _onDialogSubmit(html, isCritical) {
    const form = html[0].querySelector("form");

    const formData = foundry.utils.expandObject(new FormDataExtended(form).object);

    // get the selected parts from the form's checkboxes
    const selectedParts = Object.values(formData.parts)
      .map((isSelected, index) => {
        if (isSelected) {
          return this.parts[index];
        }

        return undefined;
      })
      .filter((part) => part !== undefined);

    // update this.parts with only the ones that were selected
    this.parts = selectedParts;

    // Append a situational bonus part
    if ( formData.bonus ) {
      this.parts.push([form.bonus.value, game.i18n.localize('DND5E.RollSituationalBonus')]);
      // const bonus = new Roll(form.bonus.value, this.data);
      // this.terms = this.terms.concat(bonus.terms);
    }

    // Apply advantage or disadvantage
    this.options.critical = isCritical;
    this.options.rollMode = form.rollMode.value;
    this.configureDamageGroup();
    return this;
  }

}
