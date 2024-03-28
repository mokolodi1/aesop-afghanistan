import itertools

from phonebuddies.Buddy import Buddy
from phonebuddies.DatabaseConnector import DatabaseConnector
from phonebuddies.EmailInfo import EmailInfo

#  jinja2 is used to make a table in _buddies_intro_table
from jinja2 import Environment, PackageLoader, select_autoescape
env = Environment(
    loader=PackageLoader("phonebuddies"),
    autoescape=select_autoescape()
)
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

    @staticmethod
    def _buddies_intro_table(first_buddy, second_buddy):
        """
        Static method to generate an HTML table with info for a buddy pair
        """

        env = Environment(loader=PackageLoader('phonebuddies', 'templates'))
        template = env.get_template('buddies_intro_table.html')
        return template.render(
            first_buddy={
                'pseudonym': first_buddy.pseudonym,
                'buddy_type': first_buddy.buddy_type,
                'email': first_buddy.email,
                'phone': first_buddy.phone,
                'location': first_buddy.location,
                'time_zone': first_buddy.time_zone,
                'user_message': first_buddy.user_message
            },
            second_buddy={
                'pseudonym': second_buddy.pseudonym,
                'buddy_type': second_buddy.buddy_type,
                'email': second_buddy.email,
                'phone': second_buddy.phone,
                'location': second_buddy.location,
                'time_zone': second_buddy.time_zone,
                'user_message': second_buddy.user_message
            }
        )

    

    def draft_buddies_email(email_info: EmailInfo, first_buddy: Buddy, second_buddy: Buddy):
        to = [first_buddy.email, second_buddy.email]
        pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
        subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms

        name_and_name = "%s and %s" % pseudonyms
        table_html = EmailDraft._buddies_intro_table(first_buddy, second_buddy)
        email_text = f"""<p>Hello {name_and_name},</p>
            <p>{email_info.introduction}</p>
            <br>
            {table_html}
            <br>
            <p>{name_and_name}, you are AESOP phone buddies this week. Please find each of your contact information below.</p>
            <p>
                You can update your buddy information by submitting this form, which will overwrite any previous info.
                Note that you'll have to fill out all the fields including those that already exist if this is your second time submitting it. 
                <a href="https://forms.gle/c8UZ6BXSxGmkw5GN7">https://forms.gle/c8UZ6BXSxGmkw5GN7</a>
            </p>
            <p>{email_info.topic}</p>
            <p>Best,</p>
            <p>Your friendly AESOP Admin</p>
            """
        
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