import itertools

from phonebuddies.Buddy import Buddy
from phonebuddies.DatabaseConnector import DatabaseConnector
from phonebuddies.EmailInfo import EmailInfo

  jinja2 and os are used to make a table in _buddies_intro_table
 rom jinja2 import Environment, PackageLoader

class EmailDraft:

    def __init__(self, to, subject, contents):
        # TODO: for development purposes, allow us to change the coming_from email via a file in secrets/
        # NOTE: likely break this into EmailDrafter and EmailDraft
        # (https://github.com/mokolodi1/aesop-afghanistan/issues/21)
        
        self.to = to
        self.coming_from = "phonebuddies@aesopafgahnistan.org"
        self.subject = subject
        self.contents = contents

    def __str__(self) -> str:
        return 'EmailDraft(to=%s; from=%s; subject="%s"; contents_length=%d)' % (self.to, self.coming_from, self.subject, len(self.contents))

    ''' Static method to generate an HTML table with info for a buddy pair'''
    @staticmethod
    def _buddies_intro_table(first_buddy, second_buddy):
        env = Environment(loader=PackageLoader('phonebuddies', 'templates'))
        template = env.get_template('buddies_intro_table.html')
        return template.render(first_buddy=first_buddy, second_buddy=second_buddy)

    '''The function above is supposed to make a table with seven rows and two columns. Make all the text
    in the top row bold. Use bold font for all the text in the in the left column. Leave
    top cell in the left column empty. Put string literals in the next six cells: 
    Pseudonym, Email, Phone, Location, Time zone, Introduction. The middle column has data 
    about the first buddy. Cells, from top to bottom, contain: first_buddy.pseudonym, 
    first_buddy.buddy_type, first_buddy.email, first_buddy.phone, first_buddy.location, 
    first_buddy.time_zone, and first_buddy.user_message. For the right column, 
    cells, from top to bottom, contain: second_buddy.pseudonym, 
    second_buddy.buddy_type, second_buddy.email, second_buddy.phone, second_buddy.location, 
    second_buddy.time_zone, and second_buddy.user_message.
    '''

    def draft_buddies_email(email_info: EmailInfo, first_buddy: Buddy, second_buddy: Buddy):
        to = [first_buddy.email, second_buddy.email]
        pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
        subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms

        name_and_name = "%s and %s" % pseudonyms
        table_html = EmailDraft._buddies_intro_table(first_buddy, second_buddy)
        email_text = f"""Hello {name_and_name},

{email_info.introduction}

{name_and_name}, you are AESOP phone buddies this week. Please find each of your contact information below.


{table_html}


'''these were replaced by the _buddies_intro_table
{first_buddy.contact_text()}
{second_buddy.contact_text()}
'''

You can update your buddy information by submitting this form, which will overwrite any previous info:
https://forms.gle/c8UZ6BXSxGmkw5GN7

{email_info.topic}

Best,

Your friendly AESOP Admin"""
        
        return EmailDraft(to, subject, email_text)

    def draft_overdue_process_admin_reminder(email):
        message = f"""Hi AESOP Phone Buddy Admin,

Don't forget to fill out the Process sheet for the AESOP phone buddies!

{DatabaseConnector.get_database_link}

Best,

Teo
"""

        return EmailDraft(email, "ACTION NEEDED: AESOP Phone Buddy Reminder", message)

    def draft_admins_without_buddy_emails(email):
            message = f"""The AESOP phone buddy emails were sent out.

This is a courtesy email given that you are an admin and did not have a buddy this week.

Any errors have been documented on the error tab here: {DatabaseConnector.get_database_link}

Best,

Teo"""
            return EmailDraft(email, "AESOP Phone Buddy emails sent (you're an admin without a buddy)", message)